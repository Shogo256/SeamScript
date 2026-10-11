// Turns the type syntax of a boundary field or a decode target into the runtime
// decoder expression (`__b.int64`, `__b.array(Order)`, ...). Only the forms the
// spec allows are accepted; everything else is reported.
import type * as t from "@babel/types";
import { type AnyNode, end, type SeamBoundaryDeclaration, start } from "./ast.js";
import { Codes } from "./diagnostics.js";

export interface BoundaryInfo {
  /** Index of the top-level statement that declares it. */
  index: number;
  node: SeamBoundaryDeclaration;
}

export interface DecoderScope {
  source: string;
  /** Boundaries declared in this file. */
  boundaries: Map<string, BoundaryInfo>;
  /** Types declared in this file that are not boundaries (type aliases, interfaces, ...). */
  otherTypes: Set<string>;
  report(node: AnyNode, code: string, message: string): void;
}

/**
 * Where the decoder is used. A field refers to other boundaries lazily when they
 * are not yet initialized at that point (itself, a later boundary, an import that
 * may be part of a cycle); a `decode` expression runs later and refers directly.
 */
export type Site = { kind: "field"; ownerIndex: number } | { kind: "decode" };

const BUILTINS: Record<string, string> = { Int64: "__b.int64", Decimal: "__b.decimal", Zoned: "__b.zoned" };

const text = (scope: DecoderScope, n: AnyNode) => scope.source.slice(start(n), end(n));

/** A literal type's value as JavaScript source, or undefined if it is not a string or number literal. */
function literalSource(node: t.TSLiteralType): string | undefined {
  const lit = node.literal;
  switch (lit.type) {
    case "StringLiteral":
      return JSON.stringify(lit.value);
    case "NumericLiteral":
      return String(lit.value);
    case "UnaryExpression":
      return lit.operator === "-" && lit.argument.type === "NumericLiteral" ? `-${lit.argument.value}` : undefined;
    case "TemplateLiteral":
      return lit.expressions.length === 0 ? JSON.stringify(lit.quasis[0]!.value.cooked) : undefined;
    default:
      return undefined;
  }
}

function unionMembers(node: t.TSType): t.TSType[] {
  return node.type === "TSUnionType" ? node.types.flatMap(unionMembers) : [node];
}

/** The literal values of a literal-only type ("a" | "b" | 1), as source text. */
export function literalSet(node: t.TSType): string[] | undefined {
  const out: string[] = [];
  for (const m of unionMembers(node)) {
    const lit = m.type === "TSLiteralType" ? literalSource(m) : undefined;
    if (lit === undefined) return undefined;
    out.push(lit);
  }
  return out;
}

const UNION_RULE = 'Unions in a boundary are limited to literal unions ("a" | "b") and T | null.';

export function decoderFor(node: t.TSType, scope: DecoderScope, site: Site): string | undefined {
  switch (node.type) {
    case "TSStringKeyword":
      return "__b.string";
    case "TSNumberKeyword":
      return "__b.number";
    case "TSBooleanKeyword":
      return "__b.boolean";
    case "TSNullKeyword":
      return "__b.null";
    case "TSLiteralType": {
      const lit = literalSource(node);
      if (lit !== undefined) return `__b.literal(${lit})`;
      scope.report(node, Codes.boundaryFieldType, "Only string and number literal types can cross a boundary.");
      return undefined;
    }
    case "TSArrayType": {
      const item = decoderFor(node.elementType, scope, site);
      return item && `__b.array(${item})`;
    }
    case "TSUnionType":
      return unionDecoder(node, scope, site);
    case "TSTypeReference":
      return referenceDecoder(node, scope, site);
    case "TSUndefinedKeyword":
      scope.report(node, Codes.boundaryFieldType, "undefined cannot arrive from outside; mark the field optional with `name?:` instead.");
      return undefined;
    case "TSAnyKeyword":
    case "TSUnknownKeyword":
      scope.report(node, Codes.boundaryFieldType, `${text(scope, node)} would let unchecked data through the boundary.`);
      return undefined;
    case "TSTypeLiteral":
      scope.report(node, Codes.boundaryFieldType, "Nested object types need a boundary of their own; declare one and refer to it by name.");
      return undefined;
    default:
      scope.report(
        node,
        Codes.boundaryFieldType,
        `\`${text(scope, node)}\` cannot cross a boundary. Allowed: string, number, boolean, null, ` +
          "Int64, Decimal, Zoned, Text<NFC|NFD>, string or number literals, boundary names, T[], T | null.",
      );
      return undefined;
  }
}

function unionDecoder(node: t.TSUnionType, scope: DecoderScope, site: Site): string | undefined {
  const members = unionMembers(node);
  const nullable = members.some((m) => m.type === "TSNullKeyword");
  const rest = members.filter((m) => m.type !== "TSNullKeyword");
  const literals = literalSet({ ...node, types: rest } as t.TSUnionType);
  let inner: string | undefined;
  if (rest.length === 0) {
    scope.report(node, Codes.boundaryFieldType, UNION_RULE);
    return undefined;
  } else if (literals !== undefined) {
    inner = `__b.literal(${literals.join(", ")})`;
  } else if (rest.length === 1 && nullable) {
    inner = decoderFor(rest[0]!, scope, site);
  } else {
    scope.report(node, Codes.boundaryFieldType, UNION_RULE);
    return undefined;
  }
  return inner && (nullable ? `__b.nullable(${inner})` : inner);
}

/** The `NFC` / `NFD` argument of `Text<...>`, in either source (`NFC`) or compiled (`"NFC"`) spelling. */
export function textForm(node: t.TSTypeReference): "NFC" | "NFD" | undefined {
  const args = node.typeArguments?.params ?? [];
  if (args.length !== 1) return undefined;
  const [arg] = args;
  let name: string | undefined;
  if (arg!.type === "TSTypeReference" && arg!.typeName.type === "Identifier" && !arg!.typeArguments) name = arg!.typeName.name;
  if (arg!.type === "TSLiteralType" && arg!.literal.type === "StringLiteral") name = arg!.literal.value;
  return name === "NFC" || name === "NFD" ? name : undefined;
}

function referenceDecoder(node: t.TSTypeReference, scope: DecoderScope, site: Site): string | undefined {
  const name = node.typeName.type === "Identifier" ? node.typeName.name : undefined;
  if (name === "Text") {
    const form = textForm(node);
    if (form !== undefined) return `__b.text("${form}")`;
    scope.report(node, Codes.textForm, "Text needs its normalization form: Text<NFC> or Text<NFD>.");
    return undefined;
  }
  if (node.typeArguments) {
    const hint = name === "Array" || name === "ReadonlyArray" ? " Write T[] instead." : "";
    scope.report(node, Codes.boundaryFieldType, `Generic types cannot cross a boundary.${hint}`);
    return undefined;
  }
  if (name !== undefined && name in BUILTINS) return BUILTINS[name];
  if (name === "Unknown") {
    scope.report(node, Codes.boundaryFieldType, "A boundary field cannot be Unknown: the boundary is where data gets checked.");
    return undefined;
  }
  const ref = text(scope, node.typeName);
  if (name !== undefined && scope.otherTypes.has(name)) {
    scope.report(node, Codes.notABoundary, `${name} is a type, not a boundary: only boundaries carry a decoder.`);
    return undefined;
  }
  if (site.kind === "decode") return ref;
  const local = name === undefined ? undefined : scope.boundaries.get(name);
  // Declared earlier in this file: already initialized. Otherwise (itself, later,
  // or imported and possibly in an import cycle) look it up when first used.
  return local !== undefined && local.index < site.ownerIndex ? ref : `__b.lazy(() => ${ref})`;
}

/** `__b.object<Name>({ ... })` for an object boundary. */
export function objectDecoder(
  decl: SeamBoundaryDeclaration & { body: t.TSTypeLiteral },
  scope: DecoderScope,
  ownerIndex: number,
): string | undefined {
  const fields: string[] = [];
  let ok = true;
  for (const member of decl.body.members) {
    if (member.type !== "TSPropertySignature" || member.computed) {
      scope.report(member, Codes.boundaryMember, "A boundary may only contain fields (`name: Type` or `name?: Type`).");
      ok = false;
      continue;
    }
    let key: string;
    if (member.key.type === "Identifier") key = member.key.name;
    else if (member.key.type === "StringLiteral") key = JSON.stringify(member.key.value);
    else {
      scope.report(member.key, Codes.boundaryMember, "Field names must be identifiers or string literals.");
      ok = false;
      continue;
    }
    const type = member.typeAnnotation?.typeAnnotation;
    if (type === undefined) {
      scope.report(member, Codes.boundaryMember, "A boundary field needs a type.");
      ok = false;
      continue;
    }
    const d = decoderFor(type, scope, { kind: "field", ownerIndex });
    if (d === undefined) {
      ok = false;
      continue;
    }
    fields.push(`  ${key}: ${member.optional ? `__b.optional(${d})` : d},`);
  }
  if (!ok) return undefined;
  const name = decl.id.name;
  return fields.length === 0 ? `__b.object<${name}>({})` : `__b.object<${name}>({\n${fields.join("\n")}\n})`;
}

/** Literal fields of an object boundary that could discriminate a union: name → values. */
function literalFields(decl: SeamBoundaryDeclaration): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of decl.body?.members ?? []) {
    if (m.type !== "TSPropertySignature" || m.optional || m.key.type !== "Identifier") continue;
    const type = m.typeAnnotation?.typeAnnotation;
    const values = type && literalSet(type);
    if (values !== undefined) out.set(m.key.name, values);
  }
  return out;
}

/** `__b.union<Name>(() => [A, B])` for a union boundary. */
export function unionBoundaryDecoder(
  decl: SeamBoundaryDeclaration & { union: t.TSType },
  scope: DecoderScope,
): string | undefined {
  const names: string[] = [];
  const local: SeamBoundaryDeclaration[] = [];
  let ok = true;
  for (const m of unionMembers(decl.union)) {
    const name = m.type === "TSTypeReference" && m.typeName.type === "Identifier" ? m.typeName.name : undefined;
    const simple = m.type === "TSTypeReference" && !m.typeArguments && !(name !== undefined && (name in BUILTINS || name === "Text"));
    if (!simple) {
      scope.report(m, Codes.boundaryUnionMember, "A union boundary may only list other boundaries: `boundary Event = Paid | Refunded`.");
      ok = false;
      continue;
    }
    if (name !== undefined && scope.otherTypes.has(name)) {
      scope.report(m, Codes.notABoundary, `${name} is a type, not a boundary: only boundaries carry a decoder.`);
      ok = false;
      continue;
    }
    names.push(text(scope, (m as t.TSTypeReference).typeName));
    const info = name === undefined ? undefined : scope.boundaries.get(name);
    if (info?.node.body) local.push(info.node);
  }
  if (!ok) return undefined;
  // When every member is declared here, the discriminant can be checked now; for
  // imported members the runtime checks it on first use.
  if (local.length === names.length && names.length > 0) {
    const fields = local.map(literalFields);
    const usable = [...fields[0]!.keys()].some((key) => {
      const seen = new Set<string>();
      for (const f of fields) {
        const values = f.get(key);
        if (values === undefined) return false;
        for (const v of values) {
          if (seen.has(v)) return false;
          seen.add(v);
        }
      }
      return true;
    });
    if (!usable) {
      scope.report(
        decl.union,
        Codes.boundaryDiscriminant,
        "Union members need a field with a literal type whose values no two members share, e.g. `kind: \"paid\"`.",
      );
      return undefined;
    }
  }
  return `__b.union<${decl.id.name}>(() => [${names.join(", ")}])`;
}
