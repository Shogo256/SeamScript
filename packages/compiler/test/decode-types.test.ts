// The types `decode` produces, for every boundary shape × every field type.
//
// A wrong type with a right value (a brand lost, a field widened to `string`)
// passes every runtime test, so these cases are compared at the type level, and
// for exact equality rather than assignability: `Zoned` widened to `string`
// would still be assignable the other way round.
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { check, cleanup } from "./helpers.js";

afterAll(cleanup);

/** [type as written in a boundary, the TypeScript type decode must produce, its encoded form]. */
const FIELDS: [string, string, string][] = [
  ["Int64", "Int64", "string"],
  ["Decimal", "Decimal", "string"],
  ["Zoned", "Zoned", "string"],
  ["Text<NFC>", 'Text<"NFC">', "string"],
  ["Text<NFD>", 'Text<"NFD">', "string"],
  ["string", "string", "string"],
  ["number", "number", "number"],
  ["boolean", "boolean", "boolean"],
  ['"a" | "b"', '"a" | "b"', '"a" | "b"'],
  ["1 | 2", "1 | 2", "1 | 2"],
  ["null", "null", "null"],
  ["Bytes", "Bytes", "Uint8Array<ArrayBuffer>"],
  ["Pcm<Int16, 16000, 1>", 'Pcm<"int16", 16000, 1>', "ArrayBuffer"],
  ["Pcm<Float32, 48000, 2>", 'Pcm<"float32", 48000, 2>', "ArrayBuffer"],
  ["Planar<Float32, 2>", 'Planar<"float32", 2>', "Float32Array[]"],
];

const paren = (t: string) => (t.includes("|") ? `(${t})` : t);

const EQUALS = "type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;";

/** One file per field type; each case is a line `same<Actual, Expected>()` that fails to type-check on a mismatch. */
function caseFile(i: number, [F, E, Enc]: [string, string, string]) {
  const nullable = F === "null" ? undefined : `${F} | null`;
  const lines: string[] = [];
  const add = (label: string, actual: string, expected: string) => lines.push(`  same<${actual}, ${expected}>(${JSON.stringify(label)});`);

  const decls = [
    `import { Inner${i} } from "./other${i}.seam";`,
    `boundary Field${i} { f: ${F} }`,
    `boundary Opt${i} { f?: ${F} }`,
    ...(nullable ? [`boundary Null${i} { f: ${nullable} }`, `boundary NullArr${i} { f: (${nullable})[] }`] : []),
    `boundary Arr${i} { f: ${paren(F)}[] }`,
    `boundary Grid${i} { f: ${paren(F)}[][] }`,
    `boundary Local${i} { f: ${F} }`,
    `boundary Nest${i} { inner: Local${i}, items: Local${i}[], maybe: Local${i} | null, other: Inner${i} }`,
    `boundary A${i} { kind: "a", f: ${F} }`,
    `boundary B${i} { kind: "b", n: number }`,
    `boundary U${i} = A${i} | B${i}`,
    `boundary Tree${i} { f: ${F}, children: Tree${i}[] }`,
    `latest async function load${i}(v: Unknown) { return decode Field${i} from v; }`,
  ];

  // A real decode of each target: its inferred result is what is being tested.
  const decodes = new Set<string>();
  const value = (target: string) => {
    decodes.add(target);
    return `Extract<typeof r_${target}, { ok: true }>["value"]`;
  };
  add("object field", `${value(`Field${i}`)}["f"]`, E);
  add("optional field", `${value(`Opt${i}`)}["f"]`, `${E} | undefined`);
  if (nullable) {
    add("nullable field", `${value(`Null${i}`)}["f"]`, `${E} | null`);
    add("array of nullable", `${value(`NullArr${i}`)}["f"]`, `(${E} | null)[]`);
  }
  add("array field", `${value(`Arr${i}`)}["f"]`, `${paren(E)}[]`);
  add("nested arrays", `${value(`Grid${i}`)}["f"]`, `${paren(E)}[][]`);
  add("nested boundary", `${value(`Nest${i}`)}["inner"]["f"]`, E);
  add("array of boundaries", `${value(`Nest${i}`)}["items"][number]["f"]`, E);
  add("nullable boundary", `NonNullable<${value(`Nest${i}`)}["maybe"]>["f"]`, E);
  add("imported boundary", `${value(`Nest${i}`)}["other"]["f"]`, E);
  add("decoding the imported boundary", `${value(`Inner${i}`)}["f"]`, E);
  add("union member", `Extract<${value(`U${i}`)}, { kind: "a" }>["f"]`, E);
  add("recursive boundary", `${value(`Tree${i}`)}["children"][number]["f"]`, E);
  add("boundary type itself", `Field${i}["f"]`, E);
  add("decode result", `typeof r_${`Field${i}`}`, `Result<Field${i}, DecodeError>`);
  add("latest result", `Awaited<ReturnType<typeof load${i}>>`, `Result<Field${i}, DecodeError> | Stale`);
  add("encoded field", `ReturnType<typeof Field${i}.encode>["f"]`, Enc);
  add("encoded nested", `ReturnType<typeof Nest${i}.encode>["items"][number]["f"]`, Enc);

  // decode of builtin targets, written directly after `decode`.
  const direct = [
    [F, E],
    [`${paren(F)}[]`, `${paren(E)}[]`],
    ...(nullable ? [[nullable, `${E} | null`]] : []),
  ];
  const directLines = direct.map(([target, expected], k) => {
    lines.push(`  same<Extract<typeof direct${i}_${k}, { ok: true }>["value"], ${expected}>(${JSON.stringify(`decode ${target}`)});`);
    return `const direct${i}_${k} = decode ${target} from v${i};`;
  });

  return {
    [`other${i}.seam.ts`]: `export boundary Inner${i} { f: ${F} }\n`,
    [`case${i}.seam.ts`]: [
      ...decls,
      EQUALS,
      `declare function same<X, Y>(label: Equals<X, Y> extends true ? string : never): void;`,
      `declare const v${i}: Unknown;`,
      ...[...decodes].map((t) => `const r_${t} = decode ${t} from v${i};`),
      ...directLines,
      `export function cases${i}() {`,
      ...lines,
      `}`,
      "",
    ].join("\n"),
  };
}

it("decode produces exactly the boundary's types, for every shape and field type", () => {
  const files = Object.assign({}, ...FIELDS.map((f, i) => caseFile(i, f)));
  // A spot check written out by hand, independent of the generator.
  files["anchor.seam.ts"] = [
    "boundary Anchor { at: Zoned, memo: Text<NFC>, price: Decimal, id: Int64 }",
    EQUALS,
    "declare const v: Unknown;",
    "const r = decode Anchor from v;",
    "const exact: Equals<typeof r, Result<Anchor, DecodeError>> = true;",
    "if (r.ok) { const at: Equals<typeof r.value.at, Zoned> = true; void at; }",
    "export { exact };",
    "",
  ].join("\n");
  const { diagnostics } = check(files);
  // Report each failure with the case it belongs to.
  const failures = diagnostics.map((d) => `${d.file.split("/").pop()}:${d.line} ${d.code} ${readFileSync(d.file, "utf8").split("\n")[d.line - 1]?.trim()}`);
  expect(failures).toEqual([]);
  // The suite is only a guard if it has cases: 15 field types, about 20 cases each.
  const cases = Object.values(files as Record<string, string>).join("\n").match(/same</g)!.length;
  expect(cases).toBeGreaterThan(290);
});

it("a plain .ts file sees the same types through an import", () => {
  const { diagnostics } = check({
    "api.seam.ts": "export boundary Order { id: Int64, at: Zoned, memo: Text<NFC>, total: Decimal, lines: Line[] }\nexport boundary Line { qty: number, price: Decimal }\n",
    "main.ts": [
      'import type { Order } from "./api.seam";',
      'import type { Decimal, Int64, Text, Zoned } from "@seamscript/runtime";',
      EQUALS,
      'export const ok: [Equals<Order["id"], Int64>, Equals<Order["at"], Zoned>, Equals<Order["memo"], Text<"NFC">>, Equals<Order["total"], Decimal>, Equals<Order["lines"][number]["price"], Decimal>] = [true, true, true, true, true];',
      "",
    ].join("\n"),
  });
  expect(diagnostics).toEqual([]);
});
