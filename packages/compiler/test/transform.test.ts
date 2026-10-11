import { describe, expect, it } from "vitest";
import { transform } from "../src/transform.js";

const run = (source: string, file = "a.seam.ts") => transform(source, file);
const code = (source: string, file?: string) => {
  const r = run(source, file);
  expect(r.diagnostics).toEqual([]);
  return r.code;
};
const codes = (source: string) => run(source).diagnostics.map((d) => d.code);

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
    expect(codes("boundary X { t: Text<NFKC> }")).toEqual(["SEAM1301", "SEAM1301"]);
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

describe("decode", () => {
  it("becomes __decode with the target's decoder", () => {
    expect(code("const r = decode Order from await res.json();")).toContain("const r = __decode(Order, await res.json());");
    expect(code("const r = decode Text<NFC>[] from v;")).toContain('const r = __decode(__b.array(__b.text("NFC")), v);');
    expect(code("const r = decode Int64 | null from v;")).toContain("const r = __decode(__b.nullable(__b.int64), v);");
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
