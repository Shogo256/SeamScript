// Turns the type syntax of a boundary field or a decode target into the runtime
// decoder expression (`__b.int64`, `__b.array(Order)`, ...). Only the forms the
// spec allows are accepted; everything else is reported.
import type * as t from "@babel/types";
import { type AnyNode, end, type FieldAnnotation, type SeamBoundaryDeclaration, type SeamConstraint, start } from "./ast.js";
import { Codes } from "./diagnostics.js";

export interface BoundaryInfo {
  /** Index of the top-level statement that declares it. */
  index: number;
  node: SeamBoundaryDeclaration;
}

/** The runtime's types that the compiler gives a meaning (decoders, Text's form argument). */
export type Builtin = "Text" | "Int64" | "Decimal" | "Zoned" | "Unknown" | "Bytes" | "Pcm" | "Planar";
export const BUILTIN_TYPES: readonly Builtin[] = ["Text", "Int64", "Decimal", "Zoned", "Unknown", "Bytes", "Pcm", "Planar"];

export interface DecoderScope {
  source: string;
  /** Boundaries declared in this file. */
  boundaries: Map<string, BoundaryInfo>;
  /** Types declared in this file that are not boundaries (type aliases, interfaces, ...). */
  otherTypes: Set<string>;
  /**
   * The runtime type a type name denotes, if any: a free `Text` (imported
   * automatically), a name imported from the runtime (`Text as T`), or a member of
   * a namespace import of it (`rt.Text`). A file's own `Text` is not the runtime's.
   */
  builtin(name: t.TSEntityName): Builtin | undefined;
  report(node: AnyNode, code: string, message: string): void;
}

/**
 * Where the decoder is used. A field refers to other boundaries lazily when they
 * are not yet initialized at that point (itself, a later boundary, an import that
 * may be part of a cycle); a `decode` expression runs later and refers directly.
 */
export type Site = { kind: "field"; ownerIndex: number } | { kind: "decode" };

const BUILTINS: Record<string, string> = { Int64: "__b.int64", Decimal: "__b.decimal", Zoned: "__b.zoned", Bytes: "__b.bytes" };

/** Sample formats as written in `Pcm<Int16, ...>` / `Planar<Float32, ...>`, and in their compiled spelling. */
const SAMPLE_FORMATS: Record<string, "int16" | "float32"> = { Int16: "int16", Float32: "float32", int16: "int16", float32: "float32" };

/** The sample format argument of `Pcm` or `Planar`, in source (`Int16`) or compiled (`"int16"`) spelling. */
export function sampleFormat(arg: t.TSType | undefined): "int16" | "float32" | undefined {
  let name: string | undefined;
  if (arg?.type === "TSTypeReference" && arg.typeName.type === "Identifier" && !arg.typeArguments) name = arg.typeName.name;
  if (arg?.type === "TSLiteralType" && arg.literal.type === "StringLiteral") name = arg.literal.value;
  return name === undefined ? undefined : SAMPLE_FORMATS[name];
}

/** A positive integer literal type (a sample rate, a channel count), or undefined. */
function positiveInteger(arg: t.TSType | undefined): number | undefined {
  if (arg?.type !== "TSLiteralType" || arg.literal.type !== "NumericLiteral") return undefined;
  const n = arg.literal.value;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const PCM_FORM = "Pcm takes a sample format, a sample rate and a channel count: Pcm<Int16, 16000, 1> or Pcm<Float32, 48000, 2>.";
const PLANAR_FORM = "Planar takes Float32 and a channel count: Planar<Float32, 1>.";

/** `__b.pcm("int16", 16000, 1)` / `__b.planar("float32", 2)`, or a report of what is wrong with the arguments. */
function audioDecoder(node: t.TSTypeReference, builtin: "Pcm" | "Planar", scope: DecoderScope): string | undefined {
  const args = node.typeArguments?.params ?? [];
  const format = sampleFormat(args[0]);
  if (builtin === "Pcm") {
    const rate = positiveInteger(args[1]);
    const channels = positiveInteger(args[2]);
    if (args.length !== 3 || format === undefined || rate === undefined || channels === undefined) {
      scope.report(node, Codes.audioType, `${PCM_FORM} The rate and the channel count are positive whole numbers.`);
      return undefined;
    }
    return `__b.pcm("${format}", ${rate}, ${channels})`;
  }
  const channels = positiveInteger(args[1]);
  if (args.length !== 2 || format !== "float32" || channels === undefined) {
    scope.report(node, Codes.audioType, format === "int16" ? `${PLANAR_FORM} Planar audio (an AudioWorklet's inputs) is always Float32; use Pcm<Int16, ...> for Int16 bytes.` : PLANAR_FORM);
    return undefined;
  }
  return `__b.planar("float32", ${channels})`;
}

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
      scope.report(node, Codes.boundaryFieldType, "Only string and number literal types can cross a boundary; for a fixed boolean use `boolean`, for a template literal use `string`.");
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
      scope.report(node, Codes.boundaryFieldType, `${text(scope, node)} would let unchecked data through the boundary; give the field its actual type, or a boundary of its own for nested data.`);
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
  const builtin = scope.builtin(node.typeName);
  if (builtin === "Text") {
    const form = textForm(node);
    if (form !== undefined) return `__b.text("${form}")`;
    scope.report(node, Codes.textForm, "Text needs its normalization form: Text<NFC> or Text<NFD>.");
    return undefined;
  }
  if (builtin === "Pcm" || builtin === "Planar") return audioDecoder(node, builtin, scope);
  if (node.typeArguments) {
    const hint = name === "Array" || name === "ReadonlyArray" ? " Write T[] instead." : "";
    scope.report(node, Codes.boundaryFieldType, `Generic types cannot cross a boundary.${hint}`);
    return undefined;
  }
  if (builtin !== undefined && builtin in BUILTINS) return BUILTINS[builtin];
  if (builtin === "Unknown") {
    scope.report(node, Codes.boundaryFieldType, "A boundary field cannot be Unknown: the boundary is where data gets checked. Give the field its actual type, or a boundary of its own for nested data.");
    return undefined;
  }
  const ref = text(scope, node.typeName);
  if (name !== undefined && scope.otherTypes.has(name)) {
    scope.report(node, Codes.notABoundary, `${name} is a type, not a boundary: only boundaries carry a decoder. Declare it with \`boundary ${name} { ... }\` instead of \`type\` or \`interface\`.`);
    return undefined;
  }
  if (site.kind === "decode") return ref;
  const local = name === undefined ? undefined : scope.boundaries.get(name);
  // Declared earlier in this file: already initialized. Otherwise (itself, later,
  // or imported and possibly in an import cycle) look it up when first used.
  return local !== undefined && local.index < site.ownerIndex ? ref : `__b.lazy(() => ${ref})`;
}

/** What a constraint can apply to. */
type ValueKind = "string" | "text" | "number" | "int64" | "array" | "bytes" | "audio" | "other";

function valueKind(node: t.TSType, scope: DecoderScope): ValueKind {
  switch (node.type) {
    case "TSStringKeyword":
      return "string";
    case "TSNumberKeyword":
      return "number";
    case "TSArrayType":
      return "array";
    case "TSTypeReference": {
      const builtin = scope.builtin(node.typeName);
      if (builtin === "Text") return "text";
      if (builtin === "Int64") return "int64";
      if (builtin === "Bytes") return "bytes";
      return builtin === "Pcm" || builtin === "Planar" ? "audio" : "other";
    }
    default:
      return "other";
  }
}

const RULES: Record<SeamConstraint["kind"], { kinds: readonly ValueKind[]; message: string }> = {
  matches: { kinds: ["string", "text"], message: "`matches` applies to string and Text<NFC|NFD> fields." },
  minLength: {
    kinds: ["text", "array", "bytes", "audio"],
    message: "`minLength` applies to Text (grapheme clusters), arrays (elements), Bytes (bytes) and Pcm / Planar (frames); for a length in characters, declare the field Text<NFC>.",
  },
  maxLength: {
    kinds: ["text", "array", "bytes", "audio"],
    message: "`maxLength` applies to Text (grapheme clusters), arrays (elements), Bytes (bytes) and Pcm / Planar (frames); for a length in characters, declare the field Text<NFC>.",
  },
  in: { kinds: ["number", "int64"], message: "`in A..B` applies to number and Int64 fields." },
};

/**
 * The decoder of a field whose type is followed by constraints. On `T | null`
 * they constrain T; on an optional field, the value when present.
 */
export function constrainedDecoder(type: t.TSType, constraints: readonly SeamConstraint[], scope: DecoderScope, site: Site): string | undefined {
  const members = unionMembers(type);
  const rest = members.filter((m) => m.type !== "TSNullKeyword");
  if (rest.length === 1 && members.length > 1) {
    const inner = constrainedDecoder(rest[0]!, constraints, scope, site);
    return inner && `__b.nullable(${inner})`;
  }
  const base = decoderFor(type, scope, site);
  if (base === undefined) return undefined;
  const kind = valueKind(type, scope);
  const seen = new Set<string>();
  let ok = true;
  const problem = (node: AnyNode, message: string) => {
    scope.report(node, Codes.boundaryConstraint, message);
    ok = false;
  };
  let pattern: string | undefined;
  let min: number | undefined;
  let max: number | undefined;
  let range: [string, string] | undefined;
  for (const c of constraints) {
    if (seen.has(c.kind)) {
      problem(c, `\`${c.kind}\` is given twice; keep one.`);
      continue;
    }
    seen.add(c.kind);
    if (!RULES[c.kind].kinds.includes(kind)) {
      problem(c, `${RULES[c.kind].message} \`${text(scope, type)}\` takes no \`${c.kind}\`.`);
      continue;
    }
    if (c.kind === "matches") {
      const { pattern: source, flags } = c.pattern!;
      if (/[gy]/.test(flags)) {
        problem(c.pattern!, "The g and y flags make a pattern's test() depend on the previous value; remove them.");
        continue;
      }
      try {
        new RegExp(source, flags);
      } catch (e) {
        problem(c.pattern!, `This pattern is not a valid regular expression: ${(e as Error).message}`);
        continue;
      }
      pattern = text(scope, c.pattern!);
    } else if (c.kind === "minLength" || c.kind === "maxLength") {
      if (!Number.isSafeInteger(c.value) || c.value! < 0) {
        problem(c, `\`${c.kind}\` takes a whole number of 0 or more.`);
        continue;
      }
      if (c.kind === "minLength") min = c.value;
      else max = c.value;
    } else {
      const bounds = [c.min!, c.max!].map((b) => b.replace(/_/g, ""));
      if (kind === "int64") {
        if (bounds.some((b) => b.includes("."))) {
          problem(c, "An Int64 range takes whole numbers: `in 0..100`.");
          continue;
        }
        if (BigInt(bounds[0]!) > BigInt(bounds[1]!)) {
          problem(c, `The range is empty: ${bounds[0]} is above ${bounds[1]}. Write the smaller bound first.`);
          continue;
        }
        range = [`${BigInt(bounds[0]!)}n`, `${BigInt(bounds[1]!)}n`];
      } else {
        const [lo, hi] = bounds.map(Number) as [number, number];
        if (lo > hi) {
          problem(c, `The range is empty: ${lo} is above ${hi}. Write the smaller bound first.`);
          continue;
        }
        range = [String(lo), String(hi)];
      }
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    problem(constraints.find((c) => c.kind === "minLength")!, `minLength ${min} is above maxLength ${max}, so no value fits.`);
  }
  if (!ok) return undefined;
  let d = base;
  if (pattern !== undefined) d = `__b.matches(${d}, ${pattern})`;
  if (min !== undefined || max !== undefined) d = max === undefined ? `__b.length(${d}, ${min})` : `__b.length(${d}, ${min ?? 0}, ${max})`;
  if (range !== undefined) d = `__b.range(${d}, ${range[0]}, ${range[1]})`;
  return d;
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
      scope.report(member.key, Codes.boundaryMember, "Field names must be identifiers or string literals; quote a computed or numeric name (`\"2fa\": boolean`).");
      ok = false;
      continue;
    }
    const annotation = member.typeAnnotation as FieldAnnotation | null | undefined;
    const type = annotation?.typeAnnotation;
    if (type === undefined) {
      scope.report(member, Codes.boundaryMember, "A boundary field needs a type: `name: Type`.");
      ok = false;
      continue;
    }
    const site: Site = { kind: "field", ownerIndex };
    const d = annotation?.constraints ? constrainedDecoder(type, annotation.constraints, scope, site) : decoderFor(type, scope, site);
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
  ownerIndex: number,
): string | undefined {
  const members = unionMembers(decl.union);
  const isBoundaryName = (m: t.TSType) => m.type === "TSTypeReference" && !m.typeArguments && scope.builtin(m.typeName) === undefined;
  if (!members.some(isBoundaryName)) {
    // An alias of a field type, constrained or not: `boundary Chunk = Pcm<Int16, 16000, 1> maxLength 3200`.
    const site: Site = { kind: "field", ownerIndex };
    return decl.constraints?.length ? constrainedDecoder(decl.union, decl.constraints, scope, site) : decoderFor(decl.union, scope, site);
  }
  const names: string[] = [];
  const local: SeamBoundaryDeclaration[] = [];
  let ok = true;
  if (decl.constraints?.length) {
    scope.report(decl.constraints[0]!, Codes.boundaryConstraint, "Constraints apply to a field type (`boundary Chunk = Pcm<Int16, 16000, 1> maxLength 3200`), not to a union of boundaries; put them on the members' fields.");
    ok = false;
  }
  for (const m of members) {
    const name = m.type === "TSTypeReference" && m.typeName.type === "Identifier" ? m.typeName.name : undefined;
    const simple = m.type === "TSTypeReference" && !m.typeArguments && scope.builtin(m.typeName) === undefined;
    if (!simple) {
      scope.report(m, Codes.boundaryUnionMember, "A union boundary may only list other boundaries: `boundary Event = Paid | Refunded`.");
      ok = false;
      continue;
    }
    if (name !== undefined && scope.otherTypes.has(name)) {
      scope.report(m, Codes.notABoundary, `${name} is a type, not a boundary: only boundaries carry a decoder. Declare it with \`boundary ${name} { ... }\` instead of \`type\` or \`interface\`.`);
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
