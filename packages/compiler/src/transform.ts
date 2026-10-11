// Expands the five SeamScript constructs into plain TypeScript.
//
// Edits are spliced into the original text (magic-string) instead of regenerating
// the file, so everything outside the constructs stays byte-for-byte as written,
// comments and formatting included, and a source map comes out alongside.
import { isReferenced } from "@babel/types";
import type * as t from "@babel/types";
import MagicString, { type SourceMap } from "magic-string";
import {
  type AnyNode,
  end,
  parse,
  type SeamBoundaryDeclaration,
  type SeamDecodeExpression,
  type SeamLatestDeclaration,
  start,
  walk,
} from "./ast.js";
import { type BoundaryInfo, type DecoderScope, decoderFor, objectDecoder, textForm, unionBoundaryDecoder } from "./decoders.js";
import { Codes, type Diagnostic, lineColumn } from "./diagnostics.js";

export const RUNTIME_MODULE = "@seamscript/runtime";

/** Runtime names a `.seam.ts` file may use without importing them (when it does not bind them itself). */
const AMBIENT_VALUES = ["Decimal", "Int64", "Text", "Unknown", "Zoned", "fetch"];
const AMBIENT_TYPES = ["DecodeError", "Err", "Ok", "Result", "Stale"];

/**
 * An expression to mark as Unknown, found by the checker's first pass. Offsets
 * are in the original source, so the result still has a single source map.
 */
export interface UnknownWrap {
  start: number;
  end: number;
  /** `Response.json()`: the expression is a promise of the data. */
  async: boolean;
}

export interface TransformOptions {
  wraps?: readonly UnknownWrap[];
}

export interface TransformResult {
  code: string;
  map: SourceMap;
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
    return { code: source, map: s.generateMap({ source: fileName, hires: true, includeContent: true }), diagnostics, syntaxError: true };
  }

  const program = ast.program;
  const s = new MagicString(source);
  const scope: DecoderScope = {
    source,
    boundaries: new Map<string, BoundaryInfo>(),
    otherTypes: new Set<string>(),
    report: (node, code, message) => report(start(node), code, message),
  };
  const bound = moduleBindings(program, scope);

  const boundaries: { node: SeamBoundaryDeclaration; index: number; exported: boolean }[] = [];
  const decodes: SeamDecodeExpression[] = [];
  const latests: SeamLatestDeclaration[] = [];
  const textForms: t.TSTypeReference[] = [];
  const usedAmbient = new Set<string>();
  const names = new Set<string>();
  const skip = new Set<AnyNode>();

  walk(program, (node, parent, grandparent) => {
    if (skip.has(node)) return false;
    switch (node.type) {
      case "SeamBoundaryDeclaration": {
        const top = parent?.type === "Program" || (parent?.type === "ExportNamedDeclaration" && grandparent?.type === "Program");
        if (!top) {
          scope.report(node, Codes.boundaryPlacement, "A boundary must be declared at the top level of a module.");
          return false;
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
      case "TSTypeReference":
        if (node.typeName.type === "Identifier" && node.typeName.name === "Text" && node.typeArguments) {
          const arg = node.typeArguments.params[0];
          if (textForm(node) === undefined) {
            scope.report(node, Codes.textForm, "Text takes its normalization form: Text<NFC> or Text<NFD>.");
          } else if (arg?.type === "TSTypeReference") {
            textForms.push(node);
          }
        }
        break;
      case "Identifier":
        names.add(node.name);
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

  const helpers = new Set<string>();
  const helperTypes = new Set<string>();

  // boundary Order { ... }  →  type Order = { ... };  const Order: ObjectDecoder<Order> = __b.object<Order>({ ... });
  // boundary Event = A | B  →  type Event = A | B;    const Event: Decoder<Event> = __b.union<Event>(() => [A, B]);
  for (const { node, index, exported } of boundaries) {
    const name = node.id.name;
    const exp = exported ? "export " : "";
    s.overwrite(start(node), start(node) + "boundary".length, "type");
    let decoder: string | undefined;
    let declaredType: string;
    if (node.body) {
      s.appendLeft(end(node.id), " =");
      decoder = objectDecoder(node as SeamBoundaryDeclaration & { body: t.TSTypeLiteral }, scope, index);
      declaredType = `__ObjectDecoder<${name}>`;
      helperTypes.add("ObjectDecoder");
    } else {
      decoder = unionBoundaryDecoder(node as SeamBoundaryDeclaration & { union: t.TSType }, scope);
      declaredType = `__Decoder<${name}>`;
      helperTypes.add("Decoder");
    }
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
    s.appendRight(w.start, w.async ? "__unknownAsync(" : "__unknown(");
    helpers.add(w.async ? "__unknownAsync" : "__unknown");
  }
  for (const w of wraps.sort((a, b) => a.end - b.end || b.start - a.start)) s.appendLeft(w.end, ")");

  // decode X from v  →  __decode(X, v)
  for (const node of decodes) {
    const decoder = decoderFor(node.typeAnnotation, scope, { kind: "decode" });
    const from = /(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*from\b/y;
    from.lastIndex = end(node.typeAnnotation);
    if (!from.test(source)) throw new Error(`Internal error: no "from" after the decode target at ${fileName}:${start(node)}`);
    s.overwrite(start(node), from.lastIndex, `__decode(${decoder ?? "undefined as any"},`);
    s.appendLeft(end(node), ")");
    helpers.add("__decode");
    if (decoder?.includes("__b.")) helpers.add("__b");
  }

  // latest async function f(...) { ... }  →  a hoisted wrapper `f` plus the original body as `f__impl`
  for (const node of latests) {
    const fn = node.declaration;
    if (fn.generator) {
      scope.report(node, Codes.latestShape, "A latest function cannot be a generator.");
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
    s.overwrite(
      start(node),
      end(fn.id!),
      `function ${name}(...args: __LatestArgs<typeof ${impl}, ${hasSignal}>): __LatestReturn<typeof ${impl}> {\n` +
        // apply() rather than a spread: the checker forbids spreading Unknown data, and
        // a latest function may legitimately take Unknown arguments.
        `  return __latestFor(${impl}${options}).apply(undefined, args);\n` +
        `}\n` +
        `${name}.fork = () => __latestFor(${impl}${options}).fork();\n` +
        `async function ${impl}`,
    );
    helpers.add("__latestFor");
    helperTypes.add("LatestArgs").add("LatestReturn");
  }

  const specifiers = [
    ...[...helpers].sort(),
    ...[...usedAmbient].filter((n) => AMBIENT_VALUES.includes(n)).sort(),
    ...[...helperTypes].sort().map((n) => `type ${n} as __${n}`),
    ...[...usedAmbient].filter((n) => AMBIENT_TYPES.includes(n)).sort().map((n) => `type ${n}`),
  ];
  if (specifiers.length > 0) {
    const line = `import { ${specifiers.join(", ")} } from "${RUNTIME_MODULE}";`;
    // After a hashbang and directive prologue ("use client"), which must stay first.
    const after = program.directives.at(-1) ?? program.interpreter;
    if (after) s.appendLeft(end(after), `\n${line}`);
    else s.prepend(`${line}\n`);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: fileName, hires: true, includeContent: true }),
    diagnostics,
    syntaxError: false,
  };
}

/** Names bound at module scope, so ambient runtime names are only imported when free. Also fills the scope's type tables. */
function moduleBindings(program: t.Program, scope: DecoderScope): Set<string> {
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
        for (const spec of decl.specifiers) names.add(spec.local.name);
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
