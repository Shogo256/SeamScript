import { afterAll, describe, expect, it } from "vitest";
import { transform } from "../src/transform.js";
import { cleanup, project } from "./helpers.js";

const run = (source: string, file = "a.seam.ts") => transform(source, file);
const code = (source: string, file?: string) => {
  const r = run(source, file);
  expect(r.diagnostics).toEqual([]);
  return r.code;
};
const codes = (source: string) => run(source).diagnostics.map((d) => d.code);

afterAll(cleanup);

describe("boundary", () => {
  it("emits the type and its decoder", () => {
    expect(code("boundary Point { x: number, y: number }")).toBe(
      'import { __b, type ObjectDecoder as __ObjectDecoder } from "@seamscript/runtime";\n' +
        "type Point = { x: number, y: number };\n" +
        "const Point: __ObjectDecoder<Point> = __b.object<Point>({\n  x: __b.number,\n  y: __b.number,\n});",
    );
  });

  it("exports both when exported", () => {
    const out = code("export boundary P { x: number }");
    expect(out).toContain("export type P = { x: number };\nexport const P: __ObjectDecoder<P> =");
  });

  it("maps every allowed field type", () => {
    const out = code(`
boundary A { n: number }
boundary B {
  s: string, b: boolean, z: null,
  i: Int64, d: Decimal, at: Zoned, t: Text<NFC>, u: Text<NFD>,
  lit: "a" | "b" | 3 | -1, maybe: string | null, maybeLit: "x" | null,
  list: A[], grid: number[][], later: C, self: B | null,
  "quoted-key": string, opt?: A,
}
boundary C { n: number }`);
    expect(out).toContain(`const B: __ObjectDecoder<B> = __b.object<B>({
  s: __b.string,
  b: __b.boolean,
  z: __b.null,
  i: __b.int64,
  d: __b.decimal,
  at: __b.zoned,
  t: __b.text("NFC"),
  u: __b.text("NFD"),
  lit: __b.literal("a", "b", 3, -1),
  maybe: __b.nullable(__b.string),
  maybeLit: __b.nullable(__b.literal("x")),
  list: __b.array(A),
  grid: __b.array(__b.array(__b.number)),
  later: __b.lazy(() => C),
  self: __b.nullable(__b.lazy(() => B)),
  "quoted-key": __b.string,
  opt: __b.optional(A),
});`);
    // The type keeps its source text, with Text<NFC> rewritten.
    expect(out).toContain('t: Text<"NFC">, u: Text<"NFD">');
  });

  it("refers to imported boundaries lazily", () => {
    expect(code('import { Customer } from "./customer.seam";\nboundary O { c: Customer }')).toContain("c: __b.lazy(() => Customer),");
  });

  it("builds a union boundary", () => {
    const out = code(`
boundary Paid { kind: "paid", amount: Decimal }
boundary Refunded { kind: "refunded", reason: string }
export boundary PaymentEvent = Paid | Refunded`);
    expect(out).toContain(
      "export type PaymentEvent = Paid | Refunded;\n" +
        "export const PaymentEvent: __Decoder<PaymentEvent> = __b.union<PaymentEvent>(() => [Paid, Refunded]);",
    );
  });

  it("rejects field types that cannot cross a boundary", () => {
    for (const field of [
      "a: any",
      "a: unknown",
      "a: undefined",
      "a: () => void",
      "a: { b: string }",
      "a: Array<string>",
      "a: string | number",
      "a: Map<string, number>",
      "a: true",
      "a: [string]",
      "a: Unknown",
    ]) {
      expect(codes(`boundary X { ${field} }`), field).toEqual(["SEAM1101"]);
    }
  });

  it("rejects methods, index signatures and non-boundary types", () => {
    expect(codes("boundary X { f(): void }")).toEqual(["SEAM1103"]);
    expect(codes("boundary X { [k: string]: number }")).toEqual(["SEAM1103"]);
    expect(codes("type T = { a: string };\nboundary X { t: T }")).toEqual(["SEAM1106"]);
    expect(codes("boundary X { t: Text<NFKC> }")).toEqual(["SEAM1301"]);
  });

  it("must be top level", () => {
    expect(codes("function f() { boundary X { a: string } }")).toEqual(["SEAM1102"]);
  });

  it("checks the discriminant of a union of local boundaries", () => {
    expect(codes(`boundary A { kind: "x", a: string }\nboundary B { kind: "x", b: string }\nboundary U = A | B`)).toEqual(["SEAM1105"]);
    expect(codes(`boundary A { a: string }\nboundary U = A | Int64`)).toEqual(["SEAM1104"]);
  });

  it("still declares the constant when the decoder has errors, to avoid follow-on errors", () => {
    expect(run("boundary X { a: any }").code).toContain("declare const X: __ObjectDecoder<X>;");
  });
});

describe("boundary constraints", () => {
  it("wraps each field's decoder and leaves the type as declared", () => {
    const out = code(`boundary Account {
  handle: string matches /^[a-z][a-z0-9_]*$/u,
  name: Text<NFC> matches /\\S/ minLength 1 maxLength 40,
  port: number in 1..65_535,
  quota?: Int64 in -5..1000,
  tags: string[] maxLength 10,
  nick: Text<NFC> | null minLength 2,
  ratio: number in -0.5..0.5
}`);
    expect(out).toContain(`type Account = {
  handle: string,
  name: Text<"NFC">,
  port: number,
  quota?: Int64,
  tags: string[],
  nick: Text<"NFC"> | null,
  ratio: number
};`);
    expect(out).toContain(`  handle: __b.matches(__b.string, /^[a-z][a-z0-9_]*$/u),
  name: __b.length(__b.matches(__b.text("NFC"), /\\S/), 1, 40),
  port: __b.range(__b.number, 1, 65535),
  quota: __b.optional(__b.range(__b.int64, -5n, 1000n)),
  tags: __b.length(__b.array(__b.string), 0, 10),
  nick: __b.nullable(__b.length(__b.text("NFC"), 2)),
  ratio: __b.range(__b.number, -0.5, 0.5),`);
  });

  it("rejects a constraint the field's type cannot take, with what it applies to", () => {
    const message = (field: string) => run(`boundary X { ${field} }`).diagnostics.map((d) => `${d.code} ${d.message}`);
    expect(message("s: string maxLength 3")).toEqual([
      "SEAM1107 `maxLength` applies to Text (grapheme clusters), arrays (elements), Bytes (bytes) and Pcm / Planar (frames); for a length in characters, declare the field Text<NFC>. `string` takes no `maxLength`.",
    ]);
    for (const field of ["n: number matches /1/", "t: Text<NFC> in 1..2", "d: Decimal in 1..2", "b: boolean minLength 1", 'k: "a" | "b" matches /a/', "a: string[] matches /a/"]) {
      expect(codes(`boundary X { ${field} }`), field).toEqual(["SEAM1107"]);
    }
  });

  it("rejects constraints that no value or no consistent test can satisfy", () => {
    for (const field of [
      "t: Text<NFC> minLength 5 maxLength 2",
      "n: number in 10..1",
      "i: Int64 in 0.5..2",
      "s: string matches /a/g",
      "s: string matches /(/",
      "t: Text<NFC> maxLength 1.5",
      "t: Text<NFC> maxLength 1 maxLength 2",
    ]) {
      expect(codes(`boundary X { ${field} }`), field).toEqual(["SEAM1107"]);
    }
  });

  it("decodes and encodes with the constraints at runtime", async () => {
    const [path] = project({
      "account.ts": code(`export boundary Account { handle: string matches /^[a-z]+$/, name: Text<NFC> maxLength 3, port: number in 1..65535, quota: Int64 in 0..10 }`),
    });
    const { Account } = (await import(path!)) as { Account: { decode(v: unknown): unknown; encode(v: unknown): unknown } };
    expect(Account.decode({ handle: "ada", name: "e\u0301ab", port: 80, quota: "10" })).toEqual({ ok: true, value: { handle: "ada", name: "\u00e9ab", port: 80, quota: 10n } });
    expect(Account.decode({ handle: "ada", name: "abcd", port: 80, quota: 1 })).toMatchObject({ ok: false, error: { path: ["name"], expected: "text of length 3 or less" } });
    expect(Account.decode({ handle: "ada", name: "a", port: 80, quota: 11 })).toMatchObject({ ok: false, error: { path: ["quota"], expected: "int64 in 0..10" } });
    expect(() => Account.encode({ handle: "Ada", name: "a", port: 80, quota: 1n })).toThrow(/at \["handle"\]/);
  });
});

describe("binary boundary types", () => {
  it("emits Bytes, Pcm and Planar decoders, with the format written as a string", () => {
    const out = code(`boundary Frame { seq: number, audio: Pcm<Int16, 16000, 1> maxLength 3200, stereo: Pcm<Float32, 48000, 2>, raw?: Bytes maxLength 1024, quantum: Planar<Float32, 2> }`);
    expect(out).toContain("type Frame = { seq: number, audio: Pcm<\"int16\", 16000, 1>, stereo: Pcm<\"float32\", 48000, 2>, raw?: Bytes, quantum: Planar<\"float32\", 2> };");
    expect(out).toContain(`  audio: __b.length(__b.pcm("int16", 16000, 1), 0, 3200),
  stereo: __b.pcm("float32", 48000, 2),
  raw: __b.optional(__b.length(__b.bytes, 0, 1024)),
  quantum: __b.planar("float32", 2),`);
    expect(out).toMatch(/^import \{ __b, type ObjectDecoder as __ObjectDecoder, type Bytes, type Planar, Pcm \}|import \{[^}]*\bPcm\b[^}]*\} from "@seamscript\/runtime"/);
  });

  it("declares a boundary for a field type on its own, constrained or not", () => {
    const out = code("export boundary MicChunk = Pcm<Int16, 16000, 1> minLength 320 maxLength 3200\nboundary Payload = Bytes;\nboundary Name = Text<NFC> maxLength 40");
    expect(out).toContain('export type MicChunk = Pcm<"int16", 16000, 1>;\nexport const MicChunk: __Decoder<MicChunk> = __b.length(__b.pcm("int16", 16000, 1), 320, 3200);');
    expect(out).toContain("type Payload = Bytes;\nconst Payload: __Decoder<Payload> = __b.bytes;");
    expect(out).toContain('type Name = Text<"NFC">;\nconst Name: __Decoder<Name> = __b.length(__b.text("NFC"), 0, 40);');
  });

  it("decodes the binary types directly", () => {
    expect(code("const r = decode Pcm<Float32, 48000, 2> from v;")).toContain('const r = __decode(__b.pcm("float32", 48000, 2), v);');
    expect(code("const r = decode Bytes from v;")).toContain("const r = __decode(__b.bytes, v);");
    expect(code("const r = decode Planar<Float32, 1> from v;")).toContain('const r = __decode(__b.planar("float32", 1), v);');
  });

  it("leaves a type parameter as the format in other type positions", () => {
    expect(code("export function play<F extends SampleFormat>(p: Pcm<F, 16000, 1>) { return p; }\ntype SampleFormat = \"int16\" | \"float32\";")).toContain("p: Pcm<F, 16000, 1>");
  });

  it("reports arguments the types don't take", () => {
    for (const field of ["a: Pcm<Int16, 16000>", "a: Pcm<Int24, 16000, 1>", "a: Pcm<Int16, 0, 1>", "a: Pcm<Int16, 44100.5, 1>", "a: Pcm<Int16, number, 1>", "a: Planar<Int16, 1>", "a: Planar<Float32>", "a: Planar<Float32, 0>"]) {
      expect(codes(`boundary X { ${field} }`), field).toEqual(["SEAM1302"]);
    }
    expect(run("boundary X { a: Planar<Int16, 1> }").diagnostics[0]!.message).toMatch(/always Float32; use Pcm<Int16, \.\.\.> for Int16 bytes/);
    expect(codes("boundary X { a: Bytes<1> }")).toEqual(["SEAM1101"]);
  });

  it("takes length constraints on the binary types only", () => {
    expect(codes("boundary X { a: Bytes matches /x/ }")).toEqual(["SEAM1107"]);
    expect(codes("boundary X { a: Pcm<Int16, 16000, 1> in 1..2 }")).toEqual(["SEAM1107"]);
  });

  it("keeps constraints off a union of boundaries", () => {
    expect(codes("boundary A { kind: \"a\" }\nboundary B { kind: \"b\" }\nboundary U = A | B maxLength 3")).toEqual(["SEAM1107"]);
  });
});

describe("decode", () => {
  it("becomes __decode with the target's decoder", () => {
    expect(code("const r = decode Order from await res.json();")).toContain("const r = __decode(Order, await res.json());");
    expect(code("const r = decode Text<NFC>[] from v;")).toContain('const r = __decode(__b.array(__b.text("NFC")), v);');
    expect(code("const r = decode Int64 | null from v;")).toContain("const r = __decode(__b.nullable(__b.int64), v);");
    expect(code(`const r = decode "buy" | "sell" | null from v;`)).toContain('const r = __decode(__b.nullable(__b.literal("buy", "sell")), v);');
  });

  it("keeps the operand's own text, parentheses and precedence", () => {
    expect(code("const r = decode A from (a, b);")).toContain("const r = __decode(A, (a, b));");
    expect(code("const r = decode A from a ?? b;")).toContain("const r = __decode(A, a) ?? b;");
    expect(code("const r = decode A from decode B from v;")).toContain("const r = __decode(A, __decode(B, v));");
    expect(code("const r = decode A /* c */ from v;")).toContain("const r = __decode(A, v);");
  });

  it("rejects targets that cannot be decoded", () => {
    expect(codes("const r = decode any from v;")).toEqual(["SEAM1101"]);
  });
});

describe("decode from json", () => {
  it("becomes __decodeJson", () => {
    expect(code("const r = decode Order from json text;")).toContain("const r = __decodeJson(Order, text);");
    expect(code("const r = decode Int64[] from /* c */ json await res.text();")).toContain("const r = __decodeJson(__b.array(__b.int64), await res.text());");
    expect(code("const r = decode A from json;")).toContain("const r = __decode(A, json);");
  });
});

describe("latest", () => {
  it("keeps a hoisted declaration and moves the body to an implementation", () => {
    const out = code("export latest async function search(q: string) {\n  return ok(q);\n}");
    expect(out).toContain(
      "export function search(...args: __LatestArgs<typeof search__impl, false>): __LatestReturn<typeof search__impl> {\n" +
        "  return __latestFor(search__impl).apply(undefined, args);\n" +
        "}\n" +
        "search.fork = () => __latestFor(search__impl).fork();\n" +
        "async function search__impl(q: string) {\n  return ok(q);\n}",
    );
  });

  it("passes the AbortSignal position", () => {
    const out = code("latest async function f(a: string, b?: number, signal?: AbortSignal) {}");
    expect(out).toContain("__LatestArgs<typeof f__impl, true>");
    expect(out).toContain("__latestFor(f__impl, { signal: 2 })");
  });

  it("avoids clashing implementation names", () => {
    expect(code("const f__impl = 1;\nlatest async function f() {}")).toContain("async function f__impl2()");
  });

  it("rejects generators", () => {
    expect(codes("latest async function* f() {}")).toEqual(["SEAM1401"]);
  });

  it("keeps a generic function's type parameters and spells a written return type", () => {
    const out = code("export latest async function get<T extends object, const K = string>(key: K, signal: AbortSignal): Promise<Result<T, Text<NFC>>> {}");
    expect(out).toContain(
      "export function get<T extends object, const K = string>(...args: __LatestArgs<typeof get__impl<T, K>, true>): Promise<Result<T, Text<\"NFC\">> | __Stale> {\n" +
        "  return __latestFor(get__impl<T, K>, { signal: 1 }).apply(undefined, args);\n" +
        "}\n" +
        "get.fork = function <T extends object, const K = string>() { return __latestFor(get__impl<T, K>, { signal: 1 }).fork(); };\n" +
        "async function get__impl<T extends object, const K = string>(key: K, signal: AbortSignal): Promise<Result<T, Text<\"NFC\">>> {}",
    );
    expect(out).toContain("type Stale as __Stale");
  });
});

describe("runtime import", () => {
  it("imports only the runtime names the file uses and does not bind itself", () => {
    const out = code("const t: Text<NFC> = Text.nfc(s);\nconst n: Int64 = 1n;\nlet r: Result<1, 2>;\nfetch(u);");
    expect(out.split("\n")[0]).toBe('import { Int64, Text, fetch, type Result } from "@seamscript/runtime";');
  });

  it("does not import names the file binds or uses only as property names", () => {
    const out = code(
      'import { fetch } from "./http";\nconst Text = 1;\nobj.Int64; ({ Zoned: 1 }); type T = { Decimal: string }; type Q = ns.Unknown;\nfetch(x); Text;',
    );
    expect(out).not.toContain("@seamscript/runtime");
  });

  it("goes after a hashbang and directives", () => {
    const out = code('#!/usr/bin/env node\n"use client";\nfetch(u);');
    expect(out).toBe('#!/usr/bin/env node\n"use client";\nimport { fetch } from "@seamscript/runtime";\nfetch(u);');
  });

  it("imports the WASM core in production output of files that use Text at run time", () => {
    expect(run("Text.nfc(u);", "a.seam.ts").code).not.toContain("@seamscript/core");
    expect(transform('"use client";\nText.nfc(u);', "a.seam.ts", { production: true }).code).toBe(
      '"use client";\nimport "@seamscript/core";\nimport { Text } from "@seamscript/runtime";\nText.nfc(u);',
    );
    // A boundary with a Text field, and a decode of Text, normalize at run time.
    expect(transform("boundary M { memo: Text<NFC> }", "a.seam.ts", { production: true }).code).toMatch(/^import "@seamscript\/core";/);
    expect(transform("export const r = (v: Unknown) => decode Text<NFC>[] from v;", "a.seam.ts", { production: true }).code).toMatch(/^import "@seamscript\/core";/);
    // Text only as a type, and files without Text, leave the core out.
    expect(transform("export const f = (t: Text<NFC>): string => t;\nfetch(u);", "a.seam.ts", { production: true }).code).not.toContain("@seamscript/core");
    expect(transform("export boundary P { n: Int64 }", "a.seam.ts", { production: true }).code).not.toContain("@seamscript/core");
    // deferCore picks the entry that does not hold up start-up.
    expect(transform("Text.nfc(u);", "a.seam.ts", { production: true, deferCore: true }).code).toMatch(/^import "@seamscript\/core\/deferred";/);
  });

  it("leaves files without SeamScript features untouched", () => {
    const source = "export const x = 1; // plain TS\n";
    expect(code(source)).toBe(source);
  });
});

it("reports syntax errors with their position", () => {
  const r = run("const a = ;\n", "bad.seam.ts");
  expect(r.syntaxError).toBe(true);
  expect(r.diagnostics).toMatchObject([{ file: "bad.seam.ts", line: 1, column: 11, code: "SEAM1000" }]);
});

it("parses .seam.tsx with JSX", () => {
  expect(code("const el = <p>{decode A from v}</p>;", "a.seam.tsx")).toContain("const el = <p>{__decode(A, v)}</p>;");
});

describe("the runtime's types are recognized by what they refer to", () => {
  it("leaves a file's own Text alone", () => {
    const out = code('import type { Text } from "./my-text";\nexport const greeting: Text<NFC> = make();');
    expect(out).toContain("Text<NFC>");
    expect(out).not.toContain("@seamscript/runtime");
  });

  it("follows an aliased import and a namespace import of the runtime", () => {
    const aliased = code('import { Text as T, Int64 as I } from "@seamscript/runtime";\nboundary Note { body: T<NFC>; id: I }\nexport const n = (x: T<NFD>) => x;');
    expect(aliased).toContain('body: T<"NFC">');
    expect(aliased).toContain('body: __b.text("NFC")');
    expect(aliased).toContain("id: __b.int64");
    expect(aliased).toContain('(x: T<"NFD">)');
    const namespaced = code('import * as rt from "@seamscript/runtime";\nboundary Note { body: rt.Text<NFC>; at: rt.Zoned }');
    expect(namespaced).toContain('body: rt.Text<"NFC">');
    expect(namespaced).toContain('body: __b.text("NFC")');
    expect(namespaced).toContain("at: __b.zoned");
  });

  it("does not take a file's own Int64 for the runtime's", () => {
    expect(codes("type Int64 = number;\nboundary Row { id: Int64 }")).toEqual(["SEAM1106"]);
  });
});

describe("parenthesized decode targets", () => {
  it("decodes an array of a nullable boundary and other parenthesized types", () => {
    expect(code("boundary Order { id: Int64 }\nconst a = decode (Order | null)[] from v;")).toContain("const a = __decode(__b.array(__b.nullable(Order)), v);");
    expect(code("const b = decode (string | null) from v;")).toContain("const b = __decode(__b.nullable(__b.string), v);");
    expect(code("const c = decode ((Text<NFC>))[] from v;")).toContain('const c = __decode(__b.array(__b.text("NFC")), v);');
  });
});
