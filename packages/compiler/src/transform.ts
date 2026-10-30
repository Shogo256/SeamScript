// Expands the five SeamScript constructs into plain TypeScript.
//
// Edits are spliced into the original text (magic-string) instead of regenerating
// the file, so everything outside the constructs stays byte-for-byte as written,
// comments and formatting included, and a source map comes out alongside.
import { isReferenced } from "@babel/types";
import type * as t from "@babel/types";
import MagicString, { type SourceMap } from "magic-string";
import { type CodeRange, segmentOffsets } from "./mappings.js";
import {
  type AnyNode,
  end,
  type FieldAnnotation,
  parse,
  type SeamBoundaryDeclaration,
  type SeamDecodeExpression,
  type SeamLatestDeclaration,
  start,
  walk,
} from "./ast.js";
import {
  BUILTIN_TYPES,
  type Builtin,
  type BoundaryInfo,
  type DecoderScope,
  decoderFor,
  objectDecoder,
  sampleFormat,
  textForm,
  unionBoundaryDecoder,
} from "./decoders.js";
import { Codes, type Diagnostic, lineColumn } from "./diagnostics.js";

export const RUNTIME_MODULE = "@seamscript/runtime";
export const CORE_MODULE = "@seamscript/core";
export const DEFERRED_CORE_MODULE = "@seamscript/core/deferred";

/** Runtime names a `.seam.ts` file may use without importing them (when it does not bind them itself). */
const AMBIENT_VALUES = ["ChunkStream", "Decimal", "Int64", "Pcm", "Text", "Unknown", "Zoned", "fetch"];
const AMBIENT_TYPES = ["Bytes", "DecodeError", "Err", "Ok", "Planar", "Result", "Stale"];

/**
 * An expression to mark as Unknown, found by the checker's first pass. Offsets
 * are in the original source, so the result still has a single source map.
 */
export interface UnknownWrap {
  start: number;
  end: number;
  /** `Response.json()`: the expression is a promise of the data. */
  async: boolean;
  /** An AudioWorklet's `inputs`: an array whose elements are each outside data. */
  each?: true;
}

export interface TransformOptions {
  wraps?: readonly UnknownWrap[];
  /**
   * Production output of a file that uses Text at run time (a Text function, or a
   * decoder with a Text field) also imports `@seamscript/core`, whose top-level
   * await installs the WASM core before this module runs, so Text is
   * deterministic. Files without Text leave the core out of the bundle.*/
  production?: boolean;
  /**
   * Import `@seamscript/core/deferred` instead: the core loads without holding up
   * this module, and Text waits for `Text.ready` (see that entry).
   */
  deferCore?: boolean;
}

export interface TransformResult {
  code: string;
  map: SourceMap;
  /**
   * Names the transform rewrote around but that still stand for the same thing:
   * a boundary's name and the decoder constant declared for it, each boundary
   * name in a decode target and its place in the decoder expression, a latest
   * function's name and the wrapper's. With the kept text (`identityRanges`),
   * this is what an editor maps between the source and the output.
   */
  links: CodeRange[];
  diagnostics: Diagnostic[];
  /** True when the file could not be parsed; `code` is then the unchanged source. */
  syntaxError: boolean;
}

export function isSeamFile(fileName: string): boolean {
  return /\.seam\.tsx?$/.test(fileName);
}

export function transform(source: string, fileName: string, options: TransformOptions = {}): TransformResult {
  const diagnostics: Diagnostic[] = [];
  const report = (at: number, code: string, message: string) =>
    diagnostics.push({ file: fileName, ...lineColumn(source, at), code, message, category: "error" });

  let ast: t.File;
  try {
    ast = parse(source, fileName.endsWith(".tsx"));
  } catch (e) {
    const error = e as SyntaxError & { pos?: number };
    report(error.pos ?? 0, Codes.syntax, error.message.replace(/ \(\d+:\d+\)$/, ""));
    const s = new MagicString(source);
    return { code: source, map: s.generateMap({ source: fileName, hires: true, includeContent: true }), links: [], diagnostics, syntaxError: true };
  }

  const program = ast.program;
  const s = new MagicString(source);
  const runtime: RuntimeImports = { names: new Map(), namespaces: new Set() };
  const scope: DecoderScope = {
    source,
    boundaries: new Map<string, BoundaryInfo>(),
    otherTypes: new Set<string>(),
    builtin: (name) => {
      if (name.type === "TSQualifiedName") {
        const right = name.right.name as Builtin;
        return name.left.type === "Identifier" && runtime.namespaces.has(name.left.name) && BUILTIN_TYPES.includes(right) ? right : undefined;
      }
      if (name.type !== "Identifier") return undefined;
      const imported = runtime.names.get(name.name);
      if (imported !== undefined) return BUILTIN_TYPES.includes(imported as Builtin) ? (imported as Builtin) : undefined;
      return !bound.has(name.name) && BUILTIN_TYPES.includes(name.name as Builtin) ? (name.name as Builtin) : undefined;
    },
    report: (node, code, message) => report(start(node), code, message),
  };
  const bound = moduleBindings(program, scope, runtime);

  const boundaries: { node: SeamBoundaryDeclaration; index: number; exported: boolean }[] = [];
  const decodes: SeamDecodeExpression[] = [];
  // Constructs reported where they are and not expanded (see `asPlainTypeScript`).
  const rejected: (SeamBoundaryDeclaration | SeamLatestDeclaration)[] = [];
  const latests: SeamLatestDeclaration[] = [];
  const textForms: t.TSTypeReference[] = [];
  const sampleForms: t.TSTypeReference[] = [];
  const usedAmbient = new Set<string>();
  let textAtRuntime = false;
  const names = new Set<string>();
  const skip = new Set<AnyNode>();

  walk(program, (node, parent, grandparent) => {
    if (skip.has(node)) return false;
    switch (node.type) {
      case "SeamBoundaryDeclaration": {
        const top = parent?.type === "Program" || (parent?.type === "ExportNamedDeclaration" && grandparent?.type === "Program");
        if (!top) {
          scope.report(node, Codes.boundaryPlacement, "A boundary must be declared at the top level of a module; move it out of the function or block (export it if other modules need it).");
          rejected.push(node);
          break;
        }
        const stmt = parent!.type === "Program" ? node : parent!;
        boundaries.push({ node, index: program.body.indexOf(stmt as t.Statement), exported: parent!.type === "ExportNamedDeclaration" });
        break;
      }
      case "SeamDecodeExpression":
        decodes.push(node);
        // The target type is replaced by a decoder expression; nothing inside it survives.
        skip.add(node.typeAnnotation);
        break;
      case "SeamLatestDeclaration":
        latests.push(node);
        break;
      case "TSTypeReference": {
        const builtin = scope.builtin(node.typeName);
        // Pcm<Int16, ...> / Planar<Float32, ...>: the format's name, unless it is a type parameter or already a string.
        const format = node.typeArguments?.params[0];
        if ((builtin === "Pcm" || builtin === "Planar") && format?.type === "TSTypeReference" && sampleFormat(format) !== undefined) {
          sampleForms.push(format);
        }
        if (builtin === "Text" && node.typeArguments) {
          const arg = node.typeArguments.params[0];
          if (textForm(node) === undefined) {
            scope.report(node, Codes.textForm, "Text takes its normalization form: Text<NFC> or Text<NFD>.");
          } else if (arg?.type === "TSTypeReference") {
            textForms.push(node);
          }
        }
        break;
      }
      case "Identifier":
        names.add(node.name);
        // `Text.nfc(...)`, `Text.length(t)`: Text as a value, which needs the core at run time.
        if (node.name === "Text" && parent !== null && !parent.type.startsWith("TS") && isReferenced(node as t.Node, parent as t.Node, (grandparent ?? undefined) as t.Node | undefined)) {
          textAtRuntime = true;
        }
        if (
          (AMBIENT_VALUES.includes(node.name) || AMBIENT_TYPES.includes(node.name)) &&
          !bound.has(node.name) &&
          parent !== null &&
          !(parent.type === "TSQualifiedName" && parent.right === node) &&
          isReferenced(node as t.Node, parent as t.Node, (grandparent ?? undefined) as t.Node | undefined)
        ) {
          usedAmbient.add(node.name);
        }
        break;
    }
  });

  // Text<NFC> → Text<"NFC">
  for (const ref of textForms) {
    const arg = ref.typeArguments!.params[0]!;
    s.overwrite(start(arg), end(arg), `"${textForm(ref)}"`);
  }
  // Pcm<Int16, 16000, 1> → Pcm<"int16", 16000, 1>
  for (const arg of sampleForms) s.overwrite(start(arg), end(arg), `"${sampleFormat(arg)}"`);

  const helpers = new Set<string>();
  const helperTypes = new Set<string>();

  // boundary Order { ... }  →  type Order = { ... };  const Order: ObjectDecoder<Order> = __b.object<Order>({ ... });
  // boundary Event = A | B  →  type Event = A | B;    const Event: Decoder<Event> = __b.union<Event>(() => [A, B]);
  // `boundary Name { ... }` → `type Name = { ... }`, constraints removed (they
  // check values, not types). Returns the type of the decoder constant.
  const boundaryType = (node: SeamBoundaryDeclaration): string => {
    s.overwrite(start(node), start(node) + "boundary".length, "type");
    for (const member of node.body?.members ?? []) {
      const annotation = (member as { typeAnnotation?: FieldAnnotation | null }).typeAnnotation;
      const constraints = annotation?.constraints;
      if (constraints?.length) s.remove(end(annotation!.typeAnnotation), end(constraints[constraints.length - 1]!));
    }
    if (node.body) {
      s.appendLeft(end(node.id), " =");
      helperTypes.add("ObjectDecoder");
      return `__ObjectDecoder<${node.id.name}>`;
    }
    if (node.constraints?.length) s.remove(end(node.union!), end(node.constraints[node.constraints.length - 1]!));
    helperTypes.add("Decoder");
    return `__Decoder<${node.id.name}>`;
  };

  for (const { node, index, exported } of boundaries) {
    const name = node.id.name;
    const exp = exported ? "export " : "";
    const declaredType = boundaryType(node);
    const decoder = node.body
      ? objectDecoder(node as SeamBoundaryDeclaration & { body: t.TSTypeLiteral }, scope, index)
      : unionBoundaryDecoder(node as SeamBoundaryDeclaration & { union: t.TSType }, scope, index);
    const semicolon = source[end(node) - 1] === ";" ? "" : ";";
    // On error, declare the constant anyway so the rest of the file type-checks quietly.
    const constant = decoder === undefined ? `${exp}declare const ${name}: ${declaredType};` : `${exp}const ${name}: ${declaredType} = ${decoder};`;
    if (decoder !== undefined) helpers.add("__b");
    s.appendLeft(end(node), `${semicolon}\n${constant}`);
  }

  // Sources of outside data: e.data  →  __unknown(e.data). Applied before `decode`
  // so that a wrap ending where a decode ends closes first: __decode(X, __unknown(v)).
  const wraps = [...(options.wraps ?? [])];
  for (const w of [...wraps].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const helper = w.async ? "__unknownAsync" : w.each ? "__unknownEach" : "__unknown";
    s.appendRight(w.start, `${helper}(`);
    helpers.add(helper);
  }
  for (const w of wraps.sort((a, b) => a.end - b.end || b.start - a.start)) s.appendLeft(w.end, ")");

  // decode X from v       →  __decode(X, v)
  // decode X from json v  →  __decodeJson(X, v)
  const decoderTexts = new Map<SeamDecodeExpression, string>();
  for (const node of decodes) {
    const decoder = decoderFor(node.typeAnnotation, scope, { kind: "decode" });
    decoderTexts.set(node, decoder ?? "undefined as any");
    // Parentheses around the whole target are not part of its node (Babel keeps no
    // node for them); the parser has checked that `from` follows them.
    const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
    const json = node.json ? String.raw`${gap}json\b` : "";
    const from = new RegExp(String.raw`(?:\s|\)|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*from\b${json}`, "y");
    from.lastIndex = end(node.typeAnnotation);
    if (!from.test(source)) throw new Error(`Internal error: no "from" after the decode target at ${fileName}:${start(node)}`);
    const helper = decodeHelper(node);
    s.overwrite(start(node), from.lastIndex, `${helper}(${decoder ?? "undefined as any"},`);
    s.appendLeft(end(node), ")");
    helpers.add(helper);
    if (decoder?.includes("__b.")) helpers.add("__b");
  }

  // latest async function f(...) { ... }  →  a hoisted wrapper `f` plus the original body as `f__impl`
  for (const node of latests) {
    const fn = node.declaration;
    if (fn.generator) {
      scope.report(node, Codes.latestShape, "A latest function cannot be a generator; remove the `*` and return the final value (a latest function settles once per call).");
      continue;
    }
    const name = fn.id!.name;
    let impl = `${name}__impl`;
    for (let i = 2; names.has(impl); i++) impl = `${name}__impl${i}`;
    names.add(impl);
    const last = fn.params.at(-1);
    const lastType = last?.type === "Identifier" ? last.typeAnnotation : last?.type === "AssignmentPattern" ? (last.left as t.Identifier).typeAnnotation : undefined;
    const lastTypeNode = lastType?.type === "TSTypeAnnotation" ? lastType.typeAnnotation : undefined;
    const hasSignal =
      lastTypeNode?.type === "TSTypeReference" && lastTypeNode.typeName.type === "Identifier" && lastTypeNode.typeName.name === "AbortSignal";
    const options = hasSignal ? `, { signal: ${fn.params.length - 1} }` : "";
    // A generic function keeps its type parameters: the wrapper declares the same
    // ones and refers to the implementation instantiated with them (`typeof f__impl<T>`),
    // or Parameters<> and ReturnType<> would instantiate them as unknown. Copied text
    // comes from `s`, so it carries the edits already made inside it (Text<NFC>).
    const tp = fn.typeParameters?.type === "TSTypeParameterDeclaration" ? fn.typeParameters : undefined;
    const typeParams = tp ? s.slice(start(tp), end(tp)) : "";
    const implRef = tp ? `${impl}<${tp.params.map((p) => (typeof p.name === "string" ? p.name : (p.name as t.Identifier).name)).join(", ")}>` : impl;
    // `Promise<X>` written on the declaration reads better in an editor than the
    // helper alias it equals.
    const returned = fn.returnType?.type === "TSTypeAnnotation" ? fn.returnType.typeAnnotation : undefined;
    const promised =
      returned?.type === "TSTypeReference" && returned.typeName.type === "Identifier" && returned.typeName.name === "Promise" && returned.typeArguments?.params.length === 1
        ? returned.typeArguments.params[0]!
        : undefined;
    const returnType = promised ? `Promise<${s.slice(start(promised), end(promised))} | __Stale>` : `__LatestReturn<typeof ${implRef}>`;
    s.overwrite(
      start(node),
      end(fn.id!),
      `function ${name}${typeParams}(...args: __LatestArgs<typeof ${implRef}, ${hasSignal}>): ${returnType} {\n` +
        // apply() rather than a spread: the checker forbids spreading Unknown data, and
        // a latest function may legitimately take Unknown arguments.
        `  return __latestFor(${implRef}${options}).apply(undefined, args);\n` +
        `}\n` +
        // A fork of a generic function fixes its type arguments: f.fork<T>().
        (tp
          ? `${name}.fork = function ${typeParams}() { return __latestFor(${implRef}${options}).fork(); };\n`
          : `${name}.fork = () => __latestFor(${impl}${options}).fork();\n`) +
        `async function ${impl}`,
    );
    helpers.add("__latestFor");
    helperTypes.add("LatestArgs");
    if (promised) helperTypes.add("Stale");
    else helperTypes.add("LatestReturn");
  }

  // A construct reported where it is (a boundary inside a function, a generator
  // latest function) still becomes the plain TypeScript it stands for, without its
  // runtime part: TypeScript has nothing more to report about it, and the names it
  // declares still resolve.
  for (const node of rejected) {
    if (node.type === "SeamBoundaryDeclaration") {
      const declaredType = boundaryType(node);
      const semicolon = source[end(node) - 1] === ";" ? "" : ";";
      s.appendLeft(end(node), `${semicolon} const ${node.id.name}: ${declaredType} = null!;`);
    } else {
      s.remove(start(node), start(node.declaration)); // `latest `
    }
  }

  const specifiers = [
    ...[...helpers].sort(),
    ...[...usedAmbient].filter((n) => AMBIENT_VALUES.includes(n)).sort(),
    ...[...helperTypes].sort().map((n) => `type ${n} as __${n}`),
    ...[...usedAmbient].filter((n) => AMBIENT_TYPES.includes(n)).sort().map((n) => `type ${n}`),
  ];
  // Decoders with a Text field (in a boundary or after `decode`) normalize what they decode.
  if (options.production && !textAtRuntime && s.toString().includes("__b.text(")) textAtRuntime = true;
  const imports = [
    ...(options.production && textAtRuntime ? [`import "${options.deferCore ? DEFERRED_CORE_MODULE : CORE_MODULE}";`] : []),
    ...(specifiers.length > 0 ? [`import { ${specifiers.join(", ")} } from "${RUNTIME_MODULE}";`] : []),
  ];
  if (imports.length > 0) {
    const lines = imports.join("\n");
    // After a hashbang and directive prologue ("use client"), which must stay first.
    const after = program.directives.at(-1) ?? program.interpreter;
    if (after) s.appendLeft(end(after), `\n${lines}`);
    else s.prepend(`${lines}\n`);
  }

  const code = s.toString();
  const map = s.generateMap({ source: fileName, hires: true, includeContent: true });
  return { code, map, links: links(source, code, map, boundaries, decoderTexts, latests), diagnostics, syntaxError: false };
}

const decodeHelper = (node: SeamDecodeExpression) => (node.json ? "__decodeJson" : "__decode");

function links(
  source: string,
  code: string,
  map: SourceMap,
  boundaries: readonly { node: SeamBoundaryDeclaration }[],
  decoders: ReadonlyMap<SeamDecodeExpression, string>,
  latests: readonly SeamLatestDeclaration[],
): CodeRange[] {
  const out: CodeRange[] = [];
  // Where each rewritten construct starts in the output: an overwritten span has
  // one segment, at its start.
  const generatedAt = new Map<number, number>();
  for (const [g, src] of segmentOffsets(source, code, map)) if (!generatedAt.has(src)) generatedAt.set(src, g);

  for (const { node } of boundaries) {
    const name = node.id.name;
    const at = code.indexOf(`const ${name}: __`);
    if (at >= 0) out.push({ source: start(node.id), generated: at + "const ".length, length: name.length });
  }
  for (const [node, decoder] of decoders) {
    const at = generatedAt.get(start(node));
    const helper = decodeHelper(node);
    if (at === undefined || !code.startsWith(`${helper}(${decoder},`, at)) continue;
    // The decoder names the target's boundaries in the order the type does.
    let from = 0;
    walk(node.typeAnnotation, (n) => {
      if (n.type !== "Identifier") return;
      const m = new RegExp(`(?<![\\w$])${n.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      m.lastIndex = from;
      const hit = m.exec(decoder);
      if (hit === null) return;
      from = hit.index + n.name.length;
      out.push({ source: start(n), generated: at + helper.length + 1 + hit.index, length: n.name.length });
    });
  }
  for (const node of latests) {
    const id = node.declaration.id!;
    const at = generatedAt.get(start(node));
    if (at !== undefined && code.startsWith(`function ${id.name}(`, at)) out.push({ source: start(id), generated: at + "function ".length, length: id.name.length });
  }
  return out;
}

/** What a file imports from the runtime: local name → exported name, and namespace imports. */
interface RuntimeImports {
  names: Map<string, string>;
  namespaces: Set<string>;
}

/** Names bound at module scope, so ambient runtime names are only imported when free. Also fills the scope's type tables. */
function moduleBindings(program: t.Program, scope: DecoderScope, runtime: RuntimeImports): Set<string> {
  const names = new Set<string>();
  const addPattern = (p: t.Node | null | undefined) => {
    if (!p) return;
    walk(p, (n, parent) => {
      // Type annotations, default values and property keys are not bindings
      // (in `{ a: b }` only `b` is bound; a shorthand's value repeats its key).
      if (n.type === "TSTypeAnnotation") return false;
      if (parent?.type === "ObjectProperty" && parent.key === n) return false;
      if (n.type === "AssignmentPattern") {
        addPattern(n.left);
        return false;
      }
      if (n.type === "Identifier") names.add(n.name);
      return undefined;
    });
  };
  program.body.forEach((stmt, index) => {
    const decl = (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" ? stmt.declaration : stmt) as AnyNode | null;
    if (!decl) return;
    switch (decl.type) {
      case "ImportDeclaration":
        for (const spec of decl.specifiers) {
          names.add(spec.local.name);
          if (decl.source.value !== RUNTIME_MODULE) continue;
          if (spec.type === "ImportNamespaceSpecifier") runtime.namespaces.add(spec.local.name);
          else if (spec.type === "ImportSpecifier") runtime.names.set(spec.local.name, spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value);
        }
        break;
      case "VariableDeclaration":
        for (const d of decl.declarations) addPattern(d.id);
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (decl.id) names.add(decl.id.name);
        if (decl.type === "ClassDeclaration" && decl.id) scope.otherTypes.add(decl.id.name);
        break;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSEnumDeclaration":
        names.add(decl.id.name);
        scope.otherTypes.add(decl.id.name);
        break;
      case "TSModuleDeclaration":
      case "TSImportEqualsDeclaration":
        if (decl.id.type === "Identifier") names.add(decl.id.name);
        break;
      case "SeamBoundaryDeclaration":
        names.add(decl.id.name);
        scope.boundaries.set(decl.id.name, { index, node: decl });
        break;
      case "SeamLatestDeclaration":
        names.add(decl.declaration.id!.name);
        break;
    }
  });
  return names;
}
