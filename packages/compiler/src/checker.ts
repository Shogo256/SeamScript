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
}

/** An expression to wrap, positioned in the transformed file. */
export interface SourceSite {
  start: number;
  end: number;
  async: boolean;
}

// Members of TypeScript's lib whose results come from outside the program.
// DOM input values (HTMLInputElement.value, ...) are deliberately absent: the DOM
// always returns a string there, and the spec makes Text.nfc(...) the explicit step.
const SOURCES = new Map<string, "call" | "async" | "read">([
  ["Body.json", "async"], // Response.json(), Request.json()
  ["JSON.parse", "call"],
  ["Storage.getItem", "call"],
  ["URLSearchParams.get", "call"],
  ["URLSearchParams.getAll", "call"],
  ["MessageEvent.data", "read"], // postMessage, WebSocket, BroadcastChannel
]);

// Member names of the sources. Only accesses with one of these names are
// resolved through the type checker: resolving every member access would cost
// nearly a full type check on top of the second program's.
const SOURCE_MEMBERS = new Set([...SOURCES.keys()].map((k) => k.slice(k.indexOf(".") + 1)));
const READ_MEMBERS = new Set([...SOURCES].filter(([, kind]) => kind === "read").map(([k]) => k.slice(k.indexOf(".") + 1)));

export interface Checker {
  /** Pass 1: where outside data enters the file. */
  findSources(program: ts.Program, file: ts.SourceFile): { sites: SourceSite[]; findings: Finding[] };
  /** Pass 2: Unknown flow, Text code-unit access and JSON.stringify of bigint. */
  checkFlows(program: ts.Program, file: ts.SourceFile, runtimeFile: string | undefined): Finding[];
}

export function createChecker(ts: typeof import("typescript")): Checker {
  function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  }

  function sourceOf(program: ts.Program, symbol: ts.Symbol | undefined): { kind: "call" | "async" | "read"; name: string } | undefined {
    for (const decl of symbol?.declarations ?? []) {
      const owner = decl.parent;
      if (!ts.isInterfaceDeclaration(owner) || !program.isSourceFileDefaultLibrary(decl.getSourceFile())) continue;
      const name = `${owner.name.text}.${symbol!.name}`;
      const kind = SOURCES.get(name);
      if (kind !== undefined) return { kind, name };
    }
    return undefined;
  }

  function memberSymbol(checker: ts.TypeChecker, node: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
    return ts.isStringLiteralLike(node.argumentExpression) ? checker.getSymbolAtLocation(node.argumentExpression) : undefined;
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

    const visit = (node: ts.Node): void => {
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && SOURCE_MEMBERS.has(memberName(node) ?? "") && !isAssignmentTarget(node)) {
        const source = sourceOf(program, memberSymbol(checker, node));
        if (source?.kind === "read") {
          sites.push({ start: node.getStart(file), end: node.getEnd(), async: false });
        } else if (source !== undefined) {
          const call = node.parent;
          if (ts.isCallExpression(call) && call.expression === node) {
            sites.push({ start: call.getStart(file), end: call.getEnd(), async: source.kind === "async" });
          } else {
            findings.push({
              pos: node.getStart(file),
              end: node.getEnd(),
              code: Codes.sourceReference,
              message: `${source.name} returns outside data, so it must be called directly where it is used (\`${node.getText(file)}(...)\`); a reference to it (.bind, .call, an alias) cannot be tracked.`,
            });
          }
        }
      }
      // const { data } = event  — the binding would receive the data untracked.
      if (ts.isObjectBindingPattern(node)) {
        let type: ts.Type | undefined;
        for (const element of node.elements) {
          const key = element.propertyName ?? element.name;
          if ((!ts.isIdentifier(key) && !ts.isStringLiteral(key)) || !READ_MEMBERS.has(key.text)) continue;
          type ??= checker.getTypeAtLocation(node);
          const source = sourceOf(program, type.getProperty(key.text));
          if (source?.kind === "read") {
            findings.push({
              pos: element.getStart(file),
              end: element.getEnd(),
              code: Codes.sourceDestructure,
              message: `Destructuring ${source.name} would skip marking it Unknown; read it as a property (\`event.${key.text}\`) and decode it.`,
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
  const RUNTIME_SINKS = new Set(["__decode", "decode", "log", "__unknown", "__unknownAsync"]);

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
    const report = (node: ts.Node, code: string, message: string) => findings.push({ pos: node.getStart(file), end: node.getEnd(), code, message });
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
    const hasUnknown = (node: ts.Expression) => containsUnknown(typeOf(node));

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
      if (!containsUnknown(source)) return false;
      const target = checker.getContextualType(expr);
      if (target === undefined) {
        if (untypedIsError) report(expr, Codes.unknownFlow, exitMessage("passed to an untyped function"));
        return untypedIsError;
      }
      if (!absorbs(source, target)) return false;
      // When TypeScript rejects the assignment itself, its error is enough.
      if (checker.isTypeAssignableTo(source, target)) {
        // The lib's Response would let json() escape as any: the usual cause is a
        // variable typed for fetch's result, so say what to write instead.
        const hint = show(target) === "Response" ? " `fetch` returns a SeamResponse, whose json() stays Unknown: type the variable `SeamResponse`." : "";
        report(expr, Codes.unknownFlow, `Unknown data cannot flow into ${show(target)} here; decode it first (\`decode T from ...\`).${hint}`);
      }
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
        report(
          last,
          Codes.latestSignal,
          "This parameter is an AbortSignal, but its type is not written `AbortSignal`, so it is not recognized: write `AbortSignal` here and the latest function supplies the signal (callers leave it out).",
        );
      }
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
          report(args[0], Codes.stringifyBigint, "JSON.stringify cannot serialize bigint (Int64 is a bigint); pass the boundary's encoded form, e.g. `Order.encode(order)`.");
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
        checkValue(node.expression);
      } else if (ts.isJsxExpression(node)) {
        checkValue(node.expression);
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const source = typeOf(node.expression);
        const target = typeOf(node.type);
        if (containsUnknown(source) && (!containsUnknown(target) || absorbs(source, target))) {
          report(node, Codes.unknownFlow, "Unknown data cannot be asserted with `as`; decode it instead (`decode T from ...`).");
        }
      } else if (ts.isTemplateSpan(node)) {
        if (hasUnknown(node.expression)) report(node.expression, Codes.unknownFlow, exitMessage("interpolated into a template"));
      } else if (ts.isThrowStatement(node)) {
        if (hasUnknown(node.expression)) report(node.expression, Codes.unknownFlow, exitMessage("thrown"));
      }

      // Text measures graphemes; its UTF-16 members are `never` in its type, but reading one is not a TypeScript error.
      const codeUnitAccess = ts.isElementAccessExpression(node) || (ts.isPropertyAccessExpression(node) && CODE_UNIT_MEMBERS.has(node.name.text));
      if (codeUnitAccess && brandOf(typeOf(node.expression)) === "Text") {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
        const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node; // already a TypeScript error
        if (ts.isElementAccessExpression(node)) {
          report(node, Codes.textCodeUnits, "Indexing Text reads UTF-16 code units; use Text.at(t, i) for graphemes.");
        } else if (name !== undefined && CODE_UNIT_MEMBERS.has(name) && !isCallee) {
          const fix = name === "length" ? "Text.length(t)" : "the Text functions (Text.length, Text.at, Text.slice)";
          report(node, Codes.textCodeUnits, `.${name} works on UTF-16 code units; use ${fix} for graphemes.`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return findings;
  }

  return { findSources, checkFlows };
}
