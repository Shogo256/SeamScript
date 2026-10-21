import { afterAll, describe, expect, it } from "vitest";
import { check, cleanup, codesByLine } from "./helpers.js";

afterAll(cleanup);

describe("the spec's Unknown example", () => {
  it("rejects every exit except decode, Unknown.log and Unknown-typed places", () => {
    const source = `boundary Plain { a: string }
function launder<T>(x: T): any { return x; }
export async function f(res: Response) {
  const v = await res.json();
  const s = v as string;
  const u: unknown = v;
  const box = [v];
  const u2: unknown = box;
  JSON.stringify(v);
  launder(v);
  Unknown.log(v);
  const w: Unknown = v;
  const r = decode Plain from v;
  return [s, u, u2, w, r, box];
}
`;
    expect(codesByLine(source)).toEqual([
      [5, "SEAM2001"], // v as string
      [5, "TS2352"], //   (TypeScript objects too)
      [6, "SEAM2001"], // const u: unknown = v
      [8, "SEAM2001"], // const u2: unknown = box
      [9, "SEAM2001"], // JSON.stringify(v)
      [10, "SEAM2002"], // launder(v)
    ]);
  });
});

describe("sources", () => {
  const sourceFile = (body: string) => `boundary P { a: string }\nexport async function f(e: MessageEvent, s: string, u: URLSearchParams) {\n${body}\n}\n`;
  const flowsOut = (expr: string) => codesByLine(sourceFile(`  const x: string = ${expr};`));

  it("marks each lib source as Unknown", () => {
    // Assigning to string fails because the value is Unknown, which TypeScript reports.
    expect(flowsOut("JSON.parse(s)")).toEqual([[3, "TS2322"]]);
    expect(flowsOut("localStorage.getItem('k')!")).toEqual([[3, "TS2322"]]);
    expect(flowsOut("u.get('q')!")).toEqual([[3, "TS2322"]]);
    expect(flowsOut("e.data")).toEqual([[3, "TS2322"]]);
    expect(flowsOut("await (await window.fetch('/x')).json()")).toEqual([[3, "TS2322"]]);
    expect(flowsOut("await (await fetch('/x')).json()")).toEqual([[3, "TS2322"]]); // the runtime's fetch
  });

  it("points a Response-typed variable for fetch's result at SeamResponse", () => {
    const body = (type: string) => `export async function f() {\n  let res: ${type};\n  res = await fetch("/x");\n  return res;\n}\n`;
    const [d] = check({ "a.seam.ts": body("Response") }).diagnostics;
    expect(d?.code).toBe("SEAM2001");
    expect(d?.message).toContain("type the variable `SeamResponse`");
    // SeamResponse needs no import, like fetch itself.
    expect(codesByLine(body("SeamResponse"))).toEqual([]);
  });

  it("keeps the brands of an object boundary's fields through decode", () => {
    // Branded strings only: with an Int64 field the brand-stripped candidate is
    // no supertype, so the bug hid behind it.
    const source = `boundary Mark { number: string, at: Zoned, memo: Text<NFC>, total: Decimal }
export function f(raw: Unknown) {
  const one = decode Mark from raw;
  const all = decode Mark[] from raw;
  if (!one.ok || !all.ok) return null;
  const at: Zoned = one.value.at;
  const memo: Text<NFC> = one.value.memo;
  const total: Decimal = one.value.total;
  const first: Zoned = all.value[0]!.at;
  return [at, memo, total, first];
}
`;
    expect(codesByLine(source)).toEqual([]);
  });

  it("lets every source be decoded", () => {
    const body = [
      "  decode P from JSON.parse(s);",
      "  decode string | null from localStorage.getItem('k');",
      "  decode string | null from u.get('q');",
      "  decode string[] from u.getAll('q');",
      "  decode P from e.data;",
      "  decode P from await (await window.fetch('/x')).json();",
    ].join("\n");
    expect(codesByLine(sourceFile(body))).toEqual([]);
  });

  it("forces decoding twice for JSON in storage: the string, then its contents", () => {
    expect(codesByLine(sourceFile("  JSON.parse(localStorage.getItem('k') ?? 'null');"))).toEqual([[3, "TS2345"]]);
    expect(codesByLine(sourceFile("  const raw = decode string | null from localStorage.getItem('k');\n  if (raw.ok) decode P from JSON.parse(raw.value ?? 'null');"))).toEqual([]);
  });

  it("rejects references and destructuring that would bypass the marking", () => {
    expect(codesByLine(sourceFile("  const parse = JSON.parse;\n  void parse;"))).toEqual([[3, "SEAM2003"]]);
    expect(codesByLine(sourceFile("  const get = localStorage.getItem.bind(localStorage);\n  void get;"))).toEqual([[3, "SEAM2003"]]);
    expect(codesByLine(sourceFile("  const { data } = e;\n  void data;"))).toEqual([[3, "SEAM2004"]]);
  });

  it("does not treat DOM input values as sources", () => {
    expect(codesByLine("export const f = (i: HTMLInputElement): string => i.value;")).toEqual([]);
  });

  it("leaves plain .ts files alone", () => {
    const { diagnostics } = check({ "a.ts": "export const x: string = JSON.parse('1');\n" });
    expect(diagnostics).toEqual([]);
  });
});

describe("ways out of Unknown", () => {
  const withV = (body: string) =>
    `declare const v: Unknown;\ndeclare const box: Unknown[];\ndeclare function take(x: { a: unknown }): void;\ndeclare const untyped: any;\n${body}\n`;
  const at5 = (body: string) => codesByLine(withV(body));

  it.each([
    ["console.log(v);", "SEAM2001"],
    ["`${v}`;", "SEAM2001"],
    ['"x" + v;', "SEAM2001"],
    ["const o: {} = { ...v };", "SEAM2001"],
    ["const a: unknown[] = [...box];", "SEAM2001"],
    ["console.log(...box);", "SEAM2001"],
    ["if (\"id\" in v) {}", "SEAM2001"],
    ["take({ a: v });", "SEAM2001"],
    ["untyped(v);", "SEAM2001"],
    ["const f = (): unknown => v;", "SEAM2001"],
    ["function g(): {} { return v; }", "SEAM2001"],
    ["const o: object = v;", "SEAM2001"],
    ["const q: unknown = Math.random() ? v : 1;", "SEAM2001"],
    ["(function <T>(x: T): unknown { return x; })(v);", "SEAM2002"],
    ['Reflect.get(v, "a");', "SEAM2002"],
  ])("%s", (body, code) => {
    expect(at5(body).filter(([, c]) => c.startsWith("SEAM"))).toEqual([[5, code]]);
  });

  it("rejects throw", () => {
    expect(at5("function t() { throw v; }")).toEqual([[5, "SEAM2001"]]);
  });

  it.each([
    "const w: Unknown = v;",
    "const arr: Unknown[] = [v, ...box];",
    "const p: Promise<Unknown> = Promise.resolve(v);",
    "const id = <T,>(x: T): T => x;\nconst k: Unknown = id(v);",
    "const m = new Map<string, Unknown>([['a', v]]);",
    "box.push(v);",
    "[...box];",
    "Object.entries(box);",
    "Reflect.get(box, 0);",
    "if (v === null || typeof v === 'string') {}",
    "Unknown.log(box);",
    "const later = async () => v;",
    "setTimeout(() => { void v; });",
  ])("allows %s", (body) => {
    expect(at5(body).filter(([, c]) => c.startsWith("SEAM"))).toEqual([]);
  });
});

describe("Text and JSON.stringify", () => {
  it("rejects UTF-16 code-unit access on Text", () => {
    const source = `const t = Text.nfc("👨‍👩‍👧");\nt.length;\nt[0];\nconst slice = t.slice;\nText.length(t);\nconst s: string = t;\ns.length;\n`;
    expect(codesByLine(source)).toEqual([
      [2, "SEAM2101"],
      [3, "SEAM2101"],
      [4, "SEAM2101"],
    ]);
  });

  it("leaves calls to TypeScript, which already rejects them", () => {
    expect(codesByLine('const t = Text.nfc("x");\nt.slice(0, 1);\n')).toEqual([[2, "TS2349"]]);
  });

  it("rejects JSON.stringify of bigint and accepts encoded values", () => {
    const source = `boundary O { id: Int64 }\ndeclare const o: O;\nJSON.stringify(o);\nJSON.stringify({ n: 1n });\nJSON.stringify(O.encode(o));\nJSON.stringify({ s: "x" });\n`;
    expect(codesByLine(source)).toEqual([
      [3, "SEAM2201"],
      [4, "SEAM2201"],
    ]);
  });
});

it("emits the wrappers so the plain output keeps the Unknown types", () => {
  const { p, paths } = check({ "a.seam.ts": "export const f = (s: string) => decode string from JSON.parse(s);\n" });
  expect(p.outputs.get(paths[0]!)!.code).toContain("__decode(__b.string, __unknown(JSON.parse(s)))");
});

describe("latest", () => {
  it("reports an AbortSignal parameter written through an alias, once", () => {
    const source = `type Sig = AbortSignal;
export latest async function search(q: string, signal: Sig): Promise<Result<string, string>> {
  return { ok: true, value: q + String(signal.aborted) };
}
export latest async function plain(q: string, signal: AbortSignal): Promise<Result<string, string>> {
  return { ok: true, value: q + String(signal.aborted) };
}
export latest async function optional(q: string, signal?: Sig | undefined): Promise<Result<string, string>> {
  return { ok: true, value: q + String(signal?.aborted) };
}
`;
    expect(codesByLine(source)).toEqual([
      [2, "SEAM1402"],
      [8, "SEAM1402"],
    ]);
  });
});
