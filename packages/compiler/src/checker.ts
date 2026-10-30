// The checker pass: the only module that uses TypeScript's TypeChecker API.
//
// Pass 1 (`findSources`) runs on the transformed program and finds where outside
// data enters: calls such as `JSON.parse(...)` and reads such as `event.data`,
// resolved through the type checker to their declarations in TypeScript's lib.
// lib.dom's return types cannot be changed, so these expressions are wrapped in
// `__unknown(...)` and the program is built again.
//
// Pass 2 (`checkFlows`) runs on that second program, where those values are typed
// `Unknown`. It enforces the spec's rule with an allow list: an expression whose
// type contains Unknown anywhere (Unknown[], { v: Unknown }, Promise<Unknown>, T
// inferred as Unknown) may only flow into `decode`, into a place whose type keeps
// Unknown in the same position, or into `Unknown.log`. Everything that would erase
// it (assertions, unknown / any / {} / object, spreads, templates, string
// concatenation, `throw`, `in`, calls that return any/unknown, spreads into such
// places) is an error.
//
// Both passes are made by `createChecker(ts)` for one instance of TypeScript: the
// command line's, or in an editor the tsserver's, whose version may differ (and
// with it the numbers behind SyntaxKind and the other enums).
import type ts = require("typescript");
import { Codes } from "./diagnostics.js";

/** A finding positioned in the transformed file. */
export interface Finding {
  pos: number;
  end: number;
  code: string;
  message: string;
  /** A mechanical fix, offered as a quick fix in the editor. */
  fix?: Fix;
  /** Not a diagnostic: a fix for TypeScript's own error `code` over this span. */
  fixOnly?: boolean;
}

/** Edits in the transformed file's positions, all within text kept from the source. */
export interface Fix {
  description: string;
  edits: { pos: number; end: number; text: string }[];
}

/** An expression to wrap, positioned in the transformed file. */
export interface SourceSite {
  start: number;
  end: number;
  async: boolean;
  /** An array whose elements are each outside data (an AudioWorklet's inputs). */
  each?: true;
}

// Members of TypeScript's lib whose results come from outside the program.
// DOM input values (HTMLInputElement.value, ...) are deliberately absent: the DOM
// always returns a string there, and the spec makes Text.nfc(...) the explicit step.
type SourceKind = "call" | "async" | "read" | "env" | "callback";

const SOURCES = new Map<string, SourceKind>([
  ["Body.json", "async"], // Response.json(), Request.json()
  ["Body.text", "async"],
  ["Body.arrayBuffer", "async"],
  ["Body.bytes", "async"],
  ["JSON.parse", "call"],
  ["Storage.getItem", "call"],
  ["StorageEvent.newValue", "read"], // another tab's localStorage
  ["StorageEvent.oldValue", "read"],
  ["URLSearchParams.get", "call"],
  ["URLSearchParams.getAll", "call"],
  ["Location.hash", "read"], // (location.search is read through URLSearchParams)
  ["History.state", "read"],
  ["Document.cookie", "read"],
  ["MessageEvent.data", "read"], // postMessage, WebSocket, BroadcastChannel, EventSource
  ["ExtendableMessageEvent.data", "read"], // a service worker's messages
  ["PushMessageData.json", "call"],
  ["PushMessageData.text", "call"],
  ["IDBRequest.result", "read"], // IndexedDB
  ["IDBCursorWithValue.value", "read"],
  ["Clipboard.readText", "async"],
  ["DataTransfer.getData", "call"], // drag and drop, paste
  ["Blob.text", "async"], // files the user picked, File included
  ["Blob.arrayBuffer", "async"], // ... and MediaRecorder's chunks
  ["Blob.bytes", "async"],
  ["MediaStreamTrack.getSettings", "call"], // the device may not honour the constraints asked for (16 kHz asked, 48 kHz given)
  ["FileReader.result", "read"],
]);

// Node.js, as @types/node declares it (matched only in its own declaration files).
//  - env: `process.env.X` (or `process.env[name]`) is Unknown; `process.env` used
//    whole (assigned, spread, destructured, passed on) is Unknown as a whole.
//  - callback: `fs.readFile(path, ..., (err, data) => ...)`: `data` is Unknown.
const NODE_SOURCES = new Map<string, SourceKind>([
  ["Process.env", "env"],
  ["fs.readFileSync", "call"],
  ["fs.readFile", "callback"],
  ["fs/promises.readFile", "async"], // also fs.promises.readFile and node:fs/promises
]);
// Called by name after `import { readFileSync } from "node:fs"`.
const NODE_BARE = new Set(["readFileSync", "readFile"]);

const isNodeTypes = (file: ts.SourceFile) => /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(file.fileName);

/** Options from a project's `"seamscript"` settings in tsconfig.json (see config.ts). */
export interface CheckerOptions {
  /**
   * More sources: `Owner.member` for a member of an interface, class, namespace or
   * object type named Owner (`Android.getData`), or a bare name for a declared
   * function or variable (`readBridge`). Calls of them become Unknown, and so do reads.
   */
  sources?: readonly string[];
  /** `any` declared by a library: Unknown (the default, "unknown") or let through ("allow"). */
  externalAny?: "unknown" | "allow";
}

export interface Checker {
  /** Pass 1: where outside data enters the file. */
  findSources(program: ts.Program, file: ts.SourceFile): { sites: SourceSite[]; findings: Finding[] };
  /** Pass 2: Unknown flow, Text code-unit access and JSON.stringify of bigint. */
  checkFlows(program: ts.Program, file: ts.SourceFile, runtimeFile: string | undefined): Finding[];
}

export function createChecker(ts: typeof import("typescript"), options: CheckerOptions = {}): Checker {
  const userSources = new Set(options.sources ?? []);
  // Member names of the sources. Only accesses with one of these names are
  // resolved through the type checker: resolving every member access would cost
  // nearly a full type check on top of the second program's.
  const SOURCE_MEMBERS = new Set([...SOURCES.keys(), ...NODE_SOURCES.keys(), ...userSources].map((k) => k.slice(k.lastIndexOf(".") + 1)));
  const BARE_SOURCES = new Set([...userSources].filter((k) => !k.includes(".")));

  function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  }

  /** The name a member's owner goes by: an interface, class or namespace, or the variable or property an object type is the type of. */
  function ownerName(decl: ts.Declaration): string | undefined {
    const owner = decl.parent;
    if ((ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) && owner.name) return owner.name.text;
    if (ts.isModuleBlock(owner) && (ts.isIdentifier(owner.parent.name) || ts.isStringLiteral(owner.parent.name))) return owner.parent.name.text;
    if (ts.isTypeLiteralNode(owner)) {
      const holder = owner.parent;
      if ((ts.isVariableDeclaration(holder) || ts.isPropertySignature(holder) || ts.isPropertyDeclaration(holder)) && ts.isIdentifier(holder.name)) return holder.name.text;
    }
    return undefined;
  }

  /** A user source is called when it is a function or method (or holds one), read otherwise. */
  function userKind(decl: ts.Declaration): SourceKind {
    if (ts.isFunctionLike(decl)) return "call";
    const type = (decl as { type?: ts.TypeNode }).type;
    return type !== undefined && ts.isFunctionTypeNode(type) ? "call" : "read";
  }

  function sourceOf(program: ts.Program, symbol: ts.Symbol | undefined): { kind: SourceKind; name: string } | undefined {
    for (const decl of symbol?.declarations ?? []) {
      const owner = ownerName(decl);
      const name = owner === undefined ? symbol!.name : `${owner}.${symbol!.name}`;
      if (owner !== undefined && ts.isInterfaceDeclaration(decl.parent) && program.isSourceFileDefaultLibrary(decl.getSourceFile())) {
        const kind = SOURCES.get(name);
        if (kind !== undefined) return { kind, name };
      }
      if (owner !== undefined && NODE_SOURCES.has(name) && isNodeTypes(decl.getSourceFile())) return { kind: NODE_SOURCES.get(name)!, name };
      if (owner !== undefined && userSources.has(name)) return { kind: userKind(decl), name };
      const topLevel = owner === undefined && (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl));
      if (topLevel && BARE_SOURCES.has(name)) return { kind: userKind(decl), name };
    }
    return undefined;
  }

  function memberSymbol(checker: ts.TypeChecker, node: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
    return ts.isStringLiteralLike(node.argumentExpression) ? checker.getSymbolAtLocation(node.argumentExpression) : undefined;
  }

  /** `process` in a class that extends AudioWorkletProcessor (whatever declares it: TypeScript's lib has no AudioWorklet scope). */
  function isWorkletProcess(checker: ts.TypeChecker, node: ts.MethodDeclaration): boolean {
    if (!ts.isIdentifier(node.name) || node.name.text !== "process") return false;
    const cls = node.parent;
    if (!ts.isClassLike(cls)) return false;
    const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (base === undefined || !/AudioWorkletProcessor$/.test(base.getText())) return false;
    let symbol = checker.getSymbolAtLocation(base);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.name === "AudioWorkletProcessor";
  }

  /** An identifier that names a value here (not a declaration, a property name or an import). */
  function isBareReference(node: ts.Identifier): boolean {
    const p = node.parent;
    // A JSX tag or attribute name, or a label: asking the type checker about one
    // (as if it were a variable) would record a "Cannot find name" error.
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node) return false;
    if (ts.isJsxAttribute(p) || ts.isJsxNamespacedName(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === node) return false;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === node) return false;
    return !isAssignmentTarget(node);
  }

  function isAssignmentTarget(node: ts.Node): boolean {
    const p = node.parent;
    return ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  }

  /** Pass 1: where outside data enters the file. */
  function findSources(program: ts.Program, file: ts.SourceFile): { sites: SourceSite[]; findings: Finding[] } {
    const checker = program.getTypeChecker();
    const sites: SourceSite[] = [];
    const findings: Finding[] = [];

    // A user source that returns a promise is wrapped like Response.json().
    const isAsync = (call: ts.CallExpression) => {
      const t = checker.getTypeAtLocation(call);
      return checker.getAwaitedType(t) !== t;
    };

    // The first parameter of `process` in AudioWorkletProcessor subclasses: audio from the audio thread.
    const workletInputs = new Set<ts.Symbol>();
    const workletInputNames = new Set<string>();
    // The data parameter of fs.readFile's callback.
    const dataParams = new Set<ts.Symbol>();
    const dataParamNames = new Set<string>();

    const visit = (node: ts.Node): void => {
      let source: { kind: SourceKind; name: string } | undefined;
      if (ts.isMethodDeclaration(node) && isWorkletProcess(checker, node)) {
        const param = node.parameters[0];
        if (param !== undefined && ts.isIdentifier(param.name)) {
          const symbol = checker.getSymbolAtLocation(param.name);
          if (symbol !== undefined) {
            workletInputs.add(symbol);
            workletInputNames.add(param.name.text);
          }
        } else if (param !== undefined) {
          findings.push({
            pos: param.getStart(file),
            end: param.getEnd(),
            code: Codes.sourceDestructure,
            message: "Destructuring the inputs of an AudioWorkletProcessor's process would skip marking them Unknown; take them as one parameter (`process(inputs)`) and decode `inputs[0]` (as `Planar<Float32, 1>`, for example).",
          });
        }
      } else if (ts.isIdentifier(node) && workletInputNames.has(node.text) && isBareReference(node) && workletInputs.has(checker.getSymbolAtLocation(node)!)) {
        sites.push({ start: node.getStart(file), end: node.getEnd(), async: false, each: true });
      } else if (ts.isIdentifier(node) && dataParamNames.has(node.text) && isBareReference(node) && dataParams.has(checker.getSymbolAtLocation(node)!)) {
        sites.push({ start: node.getStart(file), end: node.getEnd(), async: false });
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && SOURCE_MEMBERS.has(memberName(node) ?? "") && !isAssignmentTarget(node)) {
        source = sourceOf(program, memberSymbol(checker, node));
      } else if (ts.isIdentifier(node) && (BARE_SOURCES.has(node.text) || NODE_BARE.has(node.text)) && isBareReference(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        source = sourceOf(program, symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
      }
      if (source !== undefined) {
        const expr = node as ts.Expression;
        if (source.kind === "read") {
          sites.push({ start: expr.getStart(file), end: expr.getEnd(), async: false });
        } else if (source.kind === "env") {
          // process.env.X is read, unless it is written or deleted; process.env alone is read whole.
          const outer = expr.parent;
          const member = (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) && outer.expression === expr;
          if (!member) sites.push({ start: expr.getStart(file), end: expr.getEnd(), async: false });
          else if (!isAssignmentTarget(outer) && !ts.isDeleteExpression(outer.parent)) sites.push({ start: outer.getStart(file), end: outer.getEnd(), async: false });
        } else if (source.kind === "callback") {
          const call = expr.parent;
          const callback = ts.isCallExpression(call) && call.expression === expr ? call.arguments.at(-1) : undefined;
          if (callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const data = callback.parameters[1];
            if (data !== undefined && ts.isIdentifier(data.name)) {
              const symbol = checker.getSymbolAtLocation(data.name);
              if (symbol !== undefined) {
                dataParams.add(symbol);
                dataParamNames.add(data.name.text);
              }
            } else if (data !== undefined) {
              findings.push({ pos: data.getStart(file), end: data.getEnd(), code: Codes.sourceDestructure, message: "Destructuring the data fs.readFile reads would skip marking it Unknown; take it as one parameter and decode it." });
            }
          } else if (!(ts.isCallExpression(call) && call.expression === expr)) {
            findings.push({
              pos: expr.getStart(file),
              end: expr.getEnd(),
              code: Codes.sourceReference,
              message: `${source.name} passes outside data to its callback, so it must be called directly with the callback written in place; a reference to it (.bind, .call, an alias) cannot be tracked.`,
            });
          }
        } else {
          const call = expr.parent;
          if (ts.isCallExpression(call) && call.expression === expr) {
            const async = source.kind === "async" || (!SOURCES.has(source.name) && isAsync(call));
            sites.push({ start: call.getStart(file), end: call.getEnd(), async });
          } else {
            findings.push({
              pos: expr.getStart(file),
              end: expr.getEnd(),
              code: Codes.sourceReference,
              message: `${source.name} returns outside data, so it must be called directly where it is used (\`${expr.getText(file)}(...)\`); a reference to it (.bind, .call, an alias) cannot be tracked.`,
            });
          }
        }
      }
      // const { data } = event  — the binding would receive the data untracked.
      if (ts.isObjectBindingPattern(node)) {
        let type: ts.Type | undefined;
        for (const element of node.elements) {
          const key = element.propertyName ?? element.name;
          if ((!ts.isIdentifier(key) && !ts.isStringLiteral(key)) || !SOURCE_MEMBERS.has(key.text)) continue;
          type ??= checker.getTypeAtLocation(node);
          const source = sourceOf(program, type.getProperty(key.text));
          if (source?.kind === "read" || source?.kind === "env") {
            findings.push({
              pos: element.getStart(file),
              end: element.getEnd(),
              code: Codes.sourceDestructure,
              message: `Destructuring ${source.name} would skip marking it Unknown; read it as a property (\`${source.name === "Process.env" ? "process" : "event"}.${key.text}\`) and decode it.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return { sites, findings };
  }

  /** What the checker needs from the runtime package's declarations. */
  interface Runtime {
    /** The phantom brand property shared by Unknown, Text, Decimal and Zoned. */
    brand: ts.__String;
    isRuntimeDeclaration(node: ts.Node): boolean;
  }

  function loadRuntime(program: ts.Program, runtimeFile: string): Runtime | undefined {
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(runtimeFile);
    const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
    const unknownSymbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === "Unknown");
    if (unknownSymbol === undefined) return undefined;
    const alias = unknownSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(unknownSymbol) : unknownSymbol;
    const [brand] = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(alias));
    if (brand === undefined) return undefined;
    const dir = runtimeFile.slice(0, runtimeFile.lastIndexOf("/") + 1);
    return { brand: brand.escapedName, isRuntimeDeclaration: (node) => node.getSourceFile().fileName.startsWith(dir) };
  }

  // Callees that may receive Unknown: the exits and the compiler's own markers.
  const RUNTIME_SINKS = new Set(["__decode", "__decodeJson", "decode", "decodeJson", "log", "__unknown", "__unknownAsync"]);

  // String members that count UTF-16 code units, made `never` on Text by the runtime's type.
  const CODE_UNIT_MEMBERS = new Set([
    "length", "at", "charAt", "charCodeAt", "codePointAt", "slice", "substring", "substr",
    "indexOf", "lastIndexOf", "search", "padStart", "padEnd",
  ]);

  const MAX_DEPTH = 8;

  /** What checkFlows learns about types, kept for every file of the same program. */
  interface TypeFacts {
    runtime: Runtime | undefined;
    brands: Map<ts.Type, string | undefined>;
    unknownIn: Map<ts.Type, boolean>;
  }
  const facts = new WeakMap<ts.Program, Map<string | undefined, TypeFacts>>();

  function factsFor(program: ts.Program, runtimeFile: string | undefined): TypeFacts {
    let byRuntime = facts.get(program);
    if (byRuntime === undefined) facts.set(program, (byRuntime = new Map()));
    let f = byRuntime.get(runtimeFile);
    if (f === undefined) {
      const runtime = runtimeFile === undefined ? undefined : loadRuntime(program, runtimeFile);
      byRuntime.set(runtimeFile, (f = { runtime, brands: new Map(), unknownIn: new Map() }));
    }
    return f;
  }

  // Expressions whose type is always a primitive, so never contains Unknown.
  const PRIMITIVE_EXPRESSIONS = new Set([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TypeOfExpression, ts.SyntaxKind.VoidExpression, ts.SyntaxKind.DeleteExpression,
    ts.SyntaxKind.PrefixUnaryExpression,
  ]);

  /** Pass 2: Unknown flow, Text code-unit access and JSON.stringify of bigint. */
  function checkFlows(program: ts.Program, file: ts.SourceFile, runtimeFile: string | undefined): Finding[] {
    const checker = program.getTypeChecker();
    const { runtime, brands, unknownIn } = factsFor(program, runtimeFile);
    const findings: Finding[] = [];
    /** `process.env` itself (as wrapped in pass 1), where an exit was found: the one place a whole Node source is commonly tested or listed. */
    const isWholeProcessEnv = (node: ts.Node): boolean => {
      let e: ts.Node = ts.isBinaryExpression(node) ? node.right : ts.isSpreadAssignment(node) || ts.isJsxSpreadAttribute(node) ? node.expression : node;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "__unknown" && e.arguments.length === 1) e = e.arguments[0]!;
      if (!ts.isPropertyAccessExpression(e) || e.name.text !== "env") return false;
      const decl = checker.getSymbolAtLocation(e.name)?.declarations?.[0];
      return decl !== undefined && isNodeTypes(decl.getSourceFile()) && ownerName(decl) === "Process";
    };

    const ENV_HINT =
      " To check one variable, decode it: `const port = decode Int64 from process.env.PORT`, then `port.ok`; a variable that isn't set fails to decode (actual: \"undefined\").";

    const report = (node: ts.Node, code: string, message: string, fix?: Fix) =>
      findings.push({
        pos: node.getStart(file),
        end: node.getEnd(),
        code,
        message: code === Codes.unknownFlow && isWholeProcessEnv(node) ? message + ENV_HINT : message,
        ...(fix ? { fix } : {}),
      });

    // ---- Fixes -------------------------------------------------------------------------

    /** A boundary's name for its type: the compiler emits a type alias and a decoder constant of the same name. */
    const boundaryName = (t: ts.Type): string | undefined => {
      let symbol = t.aliasSymbol ?? t.getSymbol();
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      return symbol !== undefined && symbol.flags & ts.SymbolFlags.TypeAlias && symbol.flags & ts.SymbolFlags.Variable ? symbol.name : undefined;
    };

    const BUILTIN_TARGETS = new Set(["Int64", "Decimal", "Zoned", "Text"]);
    /** A type that can follow `decode`: builtin types, boundaries, literals, arrays and `| null` of those. */
    const decodableTarget = (node: ts.TypeNode): boolean => {
      switch (node.kind) {
        case ts.SyntaxKind.StringKeyword:
        case ts.SyntaxKind.NumberKeyword:
        case ts.SyntaxKind.BooleanKeyword:
        case ts.SyntaxKind.LiteralType:
          return true;
      }
      if (ts.isArrayTypeNode(node)) return decodableTarget(node.elementType);
      if (ts.isParenthesizedTypeNode(node)) return decodableTarget(node.type);
      if (ts.isUnionTypeNode(node)) return node.types.every((m) => decodableTarget(m));
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        if (BUILTIN_TARGETS.has(node.typeName.text)) return true;
        return !node.typeArguments && boundaryName(checker.getTypeAtLocation(node)) === node.typeName.text;
      }
      return false;
    };

    const isWrap = (e: ts.Expression): e is ts.CallExpression =>
      ts.isCallExpression(e) && ts.isIdentifier(e.expression) && (e.expression.text === "__unknown" || e.expression.text === "__unknownAsync");

    /** `const x: T = value` → `const x = decode T from value` (x becomes a Result to check). */
    const decodeFix = (expr: ts.Expression): Fix | undefined => {
      const decl = expr.parent;
      if (!ts.isVariableDeclaration(decl) || decl.initializer !== expr || decl.type === undefined || !decodableTarget(decl.type)) return undefined;
      // The value itself, inside the compiler's own marker if it has one.
      const value = isWrap(expr) ? expr.arguments[0]! : expr;
      const operand = ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) || ts.isCallExpression(value) || ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value);
      if (!operand) return undefined; // `decode T from a ?? b` would decode only `a`
      const target = decl.type.getText(file);
      return {
        description: `Decode as ${target} (${decl.name.getText(file)} becomes a Result to check)`,
        edits: [
          { pos: decl.name.getEnd(), end: decl.type.getEnd(), text: "" },
          { pos: value.getStart(file), end: value.getStart(file), text: `decode ${target} from ` },
        ],
      };
    };

    const show = (t: ts.Type) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);

    // getPropertyOfType() takes a name it escapes again, which never matches a
    // unique-symbol key like the brand's, so the brand is found by its escaped name.
    const brandOf = (t: ts.Type): string | undefined => {
      if (runtime === undefined || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || t.isUnion()) return undefined;
      if (brands.has(t)) return brands.get(t);
      const p = checker.getPropertiesOfType(t).find((x) => x.escapedName === runtime.brand);
      const value = p && checker.getTypeOfSymbol(p);
      const brand = value?.isStringLiteral() ? value.value : undefined;
      brands.set(t, brand);
      return brand;
    };

    const isProjectType = (t: ts.Type) =>
      (t.getSymbol()?.declarations ?? []).every((d) => {
        const sf = d.getSourceFile();
        return !program.isSourceFileDefaultLibrary(sf) && !program.isSourceFileFromExternalLibrary(sf);
      });

    /** Whether `t` mentions Unknown anywhere a value could be read from. */
    const mentionsUnknown = (t: ts.Type, depth: number, seen: Set<ts.Type>): boolean => {
      if (depth > MAX_DEPTH || seen.has(t)) return false;
      seen.add(t);
      if (brandOf(t) === "Unknown") return true;
      if (t.isUnionOrIntersection()) return t.types.some((x) => mentionsUnknown(x, depth + 1, seen));
      if (!(t.flags & ts.TypeFlags.Object)) return false;
      const objectFlags = (t as ts.ObjectType).objectFlags;
      if (objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(t as ts.TypeReference).some((x) => mentionsUnknown(x, depth + 1, seen))) return true;
      if (objectFlags & (ts.ObjectFlags.Anonymous | ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.Mapped) || isProjectType(t)) {
        if (checker.getPropertiesOfType(t).some((p) => mentionsUnknown(checker.getTypeOfSymbol(p), depth + 1, seen))) return true;
      }
      return t.getCallSignatures().some((s) => mentionsUnknown(s.getReturnType(), depth + 1, seen));
    };
    // Asked of the same types over and over (every argument, every assignment), so
    // answers from the top of a walk are kept; types are unique objects per checker.
    const containsUnknown = (t: ts.Type): boolean => {
      let r = unknownIn.get(t);
      if (r === undefined) unknownIn.set(t, (r = mentionsUnknown(t, 0, new Set())));
      return r;
    };

    /** unknown, any, object, {} and Object: types that accept anything and so erase Unknown. */
    const isTop = (t: ts.Type): boolean => {
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return true;
      if (!(t.flags & ts.TypeFlags.Object)) return false;
      const symbol = t.getSymbol();
      if (symbol?.name === "Object" && !isProjectType(t)) return true;
      return (
        checker.getPropertiesOfType(t).length === 0 &&
        t.getCallSignatures().length === 0 &&
        t.getConstructSignatures().length === 0 &&
        checker.getIndexInfosOfType(t).length === 0
      );
    };

    const containsTop = (t: ts.Type, depth = 0): boolean => {
      if (depth > 3) return false;
      if (isTop(t)) return true;
      if (t.isUnionOrIntersection()) return t.types.some((x) => containsTop(x, depth + 1));
      if (t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
        return checker.getTypeArguments(t as ts.TypeReference).some((x) => containsTop(x, depth + 1));
      }
      return false;
    };

    /** Whether assigning `source` to `target` would lose an Unknown somewhere inside it. */
    const absorbs = (source: ts.Type, target: ts.Type, depth = 0): boolean => {
      if (depth > MAX_DEPTH || !containsUnknown(source)) return false;
      if (target.flags & ts.TypeFlags.Void) return false; // the value is discarded
      if (isTop(target)) return true;
      if (brandOf(target) === "Unknown") return false;
      if (target.isUnion()) return target.types.some(isTop) || !target.types.some((x) => containsUnknown(x));
      if (source.isUnion()) return source.types.some((s) => absorbs(s, target, depth + 1));
      if (checker.isTupleType(source) && checker.isTupleType(target)) {
        const ts1 = checker.getTypeArguments(source as ts.TypeReference);
        const ts2 = checker.getTypeArguments(target as ts.TypeReference);
        return ts1.some((s, i) => ts2[i] !== undefined && absorbs(s, ts2[i]!, depth + 1));
      }
      if (checker.isArrayLikeType(source) && checker.isArrayLikeType(target)) {
        const se = checker.getIndexTypeOfType(source, ts.IndexKind.Number);
        const te = checker.getIndexTypeOfType(target, ts.IndexKind.Number);
        if (se && te) return absorbs(se, te, depth + 1);
      }
      const sa = checker.getAwaitedType(source);
      const ta = checker.getAwaitedType(target);
      if (sa && ta && sa !== source && ta !== target) return absorbs(sa, ta, depth + 1);
      if (source.flags & ts.TypeFlags.Object && target.flags & ts.TypeFlags.Object) {
        const sRef = (source as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? (source as ts.TypeReference) : undefined;
        const tRef = (target as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? (target as ts.TypeReference) : undefined;
        if (sRef && tRef && sRef.target === tRef.target) {
          const ta2 = checker.getTypeArguments(tRef);
          return checker.getTypeArguments(sRef).some((s, i) => ta2[i] !== undefined && absorbs(s, ta2[i]!, depth + 1));
        }
        const sSig = source.getCallSignatures()[0];
        const tSig = target.getCallSignatures()[0];
        if (sSig && tSig) return absorbs(sSig.getReturnType(), tSig.getReturnType(), depth + 1);
        for (const p of checker.getPropertiesOfType(target)) {
          const sp = checker.getPropertyOfType(source, p.escapedName as string);
          if (sp && absorbs(checker.getTypeOfSymbol(sp), checker.getTypeOfSymbol(p), depth + 1)) return true;
        }
        return false;
      }
      return !containsUnknown(target);
    };

    const typeOf = (node: ts.Node) => checker.getTypeAtLocation(node);

    /**
     * A reference declared as (containing) Unknown that a type guard narrowed to
     * `never`: Unknown is a brand, so `typeof v === "string"` leaves nothing of it,
     * and `never` fits every type. It is still outside data.
     */
    const narrowedUnknown = (expr: ts.Expression): boolean => {
      if (!(typeOf(expr).flags & ts.TypeFlags.Never)) return false;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      const name = ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : undefined;
      const symbol = name && checker.getSymbolAtLocation(name);
      return symbol !== undefined && containsUnknown(checker.getTypeOfSymbol(symbol));
    };
    const hasUnknown = (node: ts.Expression) => containsUnknown(typeOf(node)) || narrowedUnknown(node);
    const narrowedMessage = "Unknown data stays Unknown after a type guard such as `typeof`; decode it instead (`decode T from ...`).";

    const exitMessage = (what: string) => `Unknown data cannot be ${what}; decode it first (\`decode T from ...\`).`;

    /**
     * A value flowing into the place its contextual type describes. Returns whether
     * the flow was rejected, by this check or (when not assignable) by TypeScript.
     */
    const checkValue = (expr: ts.Expression | undefined, untypedIsError = false): boolean => {
      if (expr === undefined) return false;
      if (ts.isParenthesizedExpression(expr)) return checkValue(expr.expression, untypedIsError);
      // These are checked part by part, each part against its own contextual type.
      if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr) || ts.isConditionalExpression(expr)) return false;
      if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.operatorToken.kind)) return false;
      if (PRIMITIVE_EXPRESSIONS.has(expr.kind)) return false;
      const source = typeOf(expr);
      if (!containsUnknown(source)) {
        if (!narrowedUnknown(expr)) return false;
        report(expr, Codes.unknownFlow, narrowedMessage);
        return true;
      }
      const target = checker.getContextualType(expr);
      if (target === undefined) {
        if (untypedIsError) report(expr, Codes.unknownFlow, exitMessage("passed to an untyped function"));
        return untypedIsError;
      }
      const assignable = checker.isTypeAssignableTo(source, target);
      if (!assignable) {
        // TypeScript reports this one (TS2322, or TS2739-2741 for an object type, on the
        // variable), and its error is enough; the decode fix goes with it.
        const fix = decodeFix(expr);
        if (fix !== undefined) findings.push({ pos: expr.parent.getStart(file), end: expr.getEnd(), code: "TS2322", message: "", fix, fixOnly: true });
      }
      if (!absorbs(source, target)) return false;
      if (assignable) report(expr, Codes.unknownFlow, `Unknown data cannot flow into ${show(target)} here; decode it first (\`decode T from ...\`).`, decodeFix(expr));
      return true;
    };

    const isSink = (call: ts.CallLikeExpression): boolean => {
      const decl = checker.getResolvedSignature(call)?.getDeclaration();
      if (decl === undefined || runtime === undefined || !runtime.isRuntimeDeclaration(decl)) return false;
      const name = decl.name && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
      return name !== undefined && RUNTIME_SINKS.has(name);
    };

    const isLibMember = (node: ts.Expression, owner: string, member: string): boolean => {
      if (!ts.isPropertyAccessExpression(node)) return false;
      const symbol = checker.getSymbolAtLocation(node.name);
      return (symbol?.declarations ?? []).some(
        (d) => ts.isInterfaceDeclaration(d.parent) && d.parent.name.text === owner && symbol!.name === member && program.isSourceFileDefaultLibrary(d.getSourceFile()),
      );
    };

    const containsBigint = (t: ts.Type, depth = 0, seen = new Set<ts.Type>()): boolean => {
      if (depth > MAX_DEPTH || seen.has(t)) return false;
      seen.add(t);
      if (t.flags & ts.TypeFlags.BigIntLike) return true;
      if (t.isUnionOrIntersection()) return t.types.some((x) => containsBigint(x, depth + 1, seen));
      if (!(t.flags & ts.TypeFlags.Object)) return false;
      if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(t as ts.TypeReference).some((x) => containsBigint(x, depth + 1, seen))) return true;
      if ((t as ts.ObjectType).objectFlags & (ts.ObjectFlags.Anonymous | ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.Mapped) || isProjectType(t)) {
        return checker.getPropertiesOfType(t).some((p) => containsBigint(checker.getTypeOfSymbol(p), depth + 1, seen));
      }
      return false;
    };

    // A latest function's AbortSignal parameter is found by its written type,
    // `AbortSignal` (the transform has no types). Written through an alias it is
    // missed: the wrapper then passes no signal and callers must supply one.
    const signalChecked = new Set<ts.Node>();
    const checkLatestSignal = (call: ts.CallExpression) => {
      if (call.arguments.length !== 1 || !ts.isIdentifier(call.expression) || call.expression.text !== "__latestFor") return;
      const target = call.arguments[0]!;
      const name = ts.isExpressionWithTypeArguments(target) ? target.expression : target;
      const decl = checker.getSymbolAtLocation(name)?.valueDeclaration;
      const last = decl && ts.isFunctionDeclaration(decl) ? decl.parameters.at(-1) : undefined;
      if (last === undefined || signalChecked.has(last)) return;
      signalChecked.add(last);
      const type = checker.getTypeAtLocation(last);
      const isSignal = (t: ts.Type) =>
        (t.getSymbol()?.declarations ?? []).some((d) => ts.isInterfaceDeclaration(d) && d.name.text === "AbortSignal" && program.isSourceFileDefaultLibrary(d.getSourceFile()));
      if ((type.isUnion() ? type.types : [type]).some(isSignal)) {
        const written = last.type;
        report(
          last,
          Codes.latestSignal,
          "This parameter is an AbortSignal, but its type is not written `AbortSignal`, so it is not recognized: write `AbortSignal` here and the latest function supplies the signal (callers leave it out).",
          written && { description: "Write the type as AbortSignal", edits: [{ pos: written.getStart(file), end: written.getEnd(), text: "AbortSignal" }] },
        );
      }
    };

    /** Whether a type written in a declaration is `any`, or a type parameter that defaults to `any` (`AxiosResponse<T = any>`). */
    const declaredAny = (type: ts.TypeNode | undefined): boolean => {
      if (type === undefined) return false;
      if (type.kind === ts.SyntaxKind.AnyKeyword) return true;
      if (!ts.isTypeReferenceNode(type)) return false;
      const param = checker.getSymbolAtLocation(type.typeName)?.declarations?.[0];
      return param !== undefined && ts.isTypeParameterDeclaration(param) && param.default?.kind === ts.SyntaxKind.AnyKeyword;
    };

    /** The package that declares `decl`, when it is a library's declaration rather than the project's or TypeScript's. */
    const libraryOf = (decl: ts.Node): string | undefined => {
      const sf = decl.getSourceFile();
      if (program.isSourceFileDefaultLibrary(sf) || runtime?.isRuntimeDeclaration(decl)) return undefined;
      const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(sf.fileName);
      if (m !== null) return m[1]!.replace(/\\/g, "/");
      return program.isSourceFileFromExternalLibrary(sf) ? sf.fileName.split(/[\\/]/).pop() : undefined;
    };

    /**
     * A value a library declares as `any` is data nobody checked: an HTTP client's
     * response body, a bridge's message. It is treated like Unknown: decode is its
     * only use. Values the project itself typed `any` are left to TypeScript.
     */
    const checkExternalAny = (node: ts.PropertyAccessExpression | ts.CallExpression | ts.Identifier) => {
      if (!(typeOf(node).flags & ts.TypeFlags.Any)) return;
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) && isSink(parent)) return;
      let library: string | undefined;
      if (ts.isCallExpression(node)) {
        const decl = checker.getResolvedSignature(node)?.getDeclaration();
        if (decl !== undefined && declaredAny(decl.type)) library = libraryOf(decl);
      } else {
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const decl of symbol?.declarations ?? []) {
          if (declaredAny((decl as { type?: ts.TypeNode }).type)) library ??= libraryOf(decl);
        }
      }
      if (library === undefined) return;
      const text = node.getText(file);
      report(
        node,
        Codes.externalAny,
        `\`${text}\` is \`any\` in the type declarations of ${library}, so nothing has checked it; decode it (\`decode T from ${text}\`). Set "externalAny": "allow" in tsconfig.json's "seamscript" settings to let library \`any\` through.`,
        decodeFix(node),
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) checkLatestSignal(node);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const args = node.arguments ?? ts.factory.createNodeArray();
        const unknownArgs = args.map((arg) => (ts.isSpreadElement(arg) ? arg.expression : arg)).filter((value) => !PRIMITIVE_EXPRESSIONS.has(value.kind) && hasUnknown(value));
        // The callee and the result matter only when Unknown is passed.
        if (unknownArgs.length > 0 && !isSink(node)) {
          let rejected = false;
          for (const value of unknownArgs) if (checkValue(value, true)) rejected = true;
          // A call that accepts Unknown but returns any/unknown/{} launders it, unless
          // the result is itself marked Unknown or the arguments were already rejected.
          const result = typeOf(node);
          const wrapped = ts.isCallExpression(node.parent) && isSink(node.parent);
          if (!rejected && !wrapped && containsTop(result) && !containsUnknown(result)) {
            report(node, Codes.unknownLaunder, `This call takes Unknown data and returns ${show(result)}, which would let it out unchecked; decode it first.`);
          }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "stringify" && isLibMember(node.expression, "JSON", "stringify") && args[0] && containsBigint(typeOf(args[0]))) {
          const arg = args[0];
          const type = typeOf(arg);
          const one = boundaryName(type);
          const element = checker.isArrayType(type) ? boundaryName(checker.getTypeArguments(type as ts.TypeReference)[0]!) : undefined;
          const text = arg.getText(file);
          const encoded = one !== undefined ? `${one}.encode(${text})` : element !== undefined ? `${text}.map(${element}.encode)` : undefined;
          report(
            arg,
            Codes.stringifyBigint,
            "JSON.stringify cannot serialize bigint (Int64 is a bigint); pass the boundary's encoded form, e.g. `Order.encode(order)`.",
            encoded === undefined ? undefined : { description: `Encode with ${one ?? element}.encode`, edits: [{ pos: arg.getStart(file), end: arg.getEnd(), text: encoded }] },
          );
        }
      } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
        checkValue(node.initializer);
      } else if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) checkValue(node.right);
        else if ((op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) && (hasUnknown(node.left) || hasUnknown(node.right))) {
          report(node, Codes.unknownFlow, exitMessage("concatenated or added"));
        } else if (op === ts.SyntaxKind.InKeyword && hasUnknown(node.right)) {
          // `"id" in v` would narrow v to { id: unknown }, a way around decode.
          report(node, Codes.unknownFlow, exitMessage("tested with `in`"));
        } else if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
          checkValue(node.left);
          checkValue(node.right);
        }
      } else if (ts.isConditionalExpression(node)) {
        checkValue(node.whenTrue);
        checkValue(node.whenFalse);
      } else if (ts.isReturnStatement(node) || ts.isYieldExpression(node)) {
        checkValue(node.expression);
      } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        checkValue(node.body);
      } else if (ts.isPropertyAssignment(node)) {
        checkValue(node.initializer);
      } else if (ts.isShorthandPropertyAssignment(node)) {
        checkValue(node.name);
      } else if (ts.isArrayLiteralExpression(node)) {
        // A spread is an exit only where its destination drops Unknown: `[...box]`
        // into Unknown[] keeps it, into unknown[] erases it.
        for (const e of node.elements) {
          if (!ts.isSpreadElement(e)) {
            checkValue(e);
            continue;
          }
          const source = typeOf(e.expression);
          const target = checker.getContextualType(node);
          if (target && absorbs(source, target) && checker.isTypeAssignableTo(source, target)) {
            report(e, Codes.unknownFlow, `Unknown data cannot be spread into ${show(target)}; decode it first (\`decode T from ...\`).`);
          }
        }
      } else if (ts.isSpreadAssignment(node) || ts.isJsxSpreadAttribute(node)) {
        // An object spread copies the fields out from under the brand: the copy's
        // type has only the brand's symbol key, which TypeScript lets pass as
        // `Record<string, string>` and the like. It never keeps the data Unknown.
        if (hasUnknown(node.expression)) report(node, Codes.unknownFlow, exitMessage(ts.isJsxSpreadAttribute(node) ? "spread into JSX props" : "spread into an object"));
        else checkValue(node.expression);
      } else if (ts.isJsxExpression(node)) {
        checkValue(node.expression);
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const source = typeOf(node.expression);
        const target = typeOf(node.type);
        if (narrowedUnknown(node.expression)) {
          report(node, Codes.unknownFlow, narrowedMessage);
        } else if (containsUnknown(source) && (!containsUnknown(target) || absorbs(source, target))) {
          report(node, Codes.unknownFlow, "Unknown data cannot be asserted with `as`; decode it instead (`decode T from ...`).");
        }
      } else if (ts.isTemplateSpan(node)) {
        if (hasUnknown(node.expression)) report(node.expression, Codes.unknownFlow, exitMessage("interpolated into a template"));
      } else if (ts.isThrowStatement(node)) {
        if (hasUnknown(node.expression)) report(node.expression, Codes.unknownFlow, exitMessage("thrown"));
      }

      if (options.externalAny !== "allow" && (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || (ts.isIdentifier(node) && isBareReference(node)))) {
        checkExternalAny(node);
      }

      // Text measures graphemes; its UTF-16 members are `never` in its type, but reading one is not a TypeScript error.
      const codeUnitAccess = ts.isElementAccessExpression(node) || (ts.isPropertyAccessExpression(node) && CODE_UNIT_MEMBERS.has(node.name.text));
      if (codeUnitAccess && brandOf(typeOf(node.expression)) === "Text") {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
        const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node; // already a TypeScript error
        if (ts.isElementAccessExpression(node)) {
          const at = `Text.at(${node.expression.getText(file)}, ${node.argumentExpression.getText(file)})`;
          report(node, Codes.textCodeUnits, "Indexing Text reads UTF-16 code units; use Text.at(t, i) for graphemes.", {
            description: `Use ${at}`,
            edits: [{ pos: node.getStart(file), end: node.getEnd(), text: at }],
          });
        } else if (name !== undefined && CODE_UNIT_MEMBERS.has(name) && !isCallee) {
          const fix = name === "length" ? "Text.length(t)" : "the Text functions (Text.length, Text.at, Text.slice)";
          const length = name === "length" ? `Text.length(${node.expression.getText(file)})` : undefined;
          report(
            node,
            Codes.textCodeUnits,
            `.${name} works on UTF-16 code units; use ${fix} for graphemes.`,
            length === undefined ? undefined : { description: `Use ${length}`, edits: [{ pos: node.getStart(file), end: node.getEnd(), text: length }] },
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return findings;
  }

  return { findSources, checkFlows };
}
