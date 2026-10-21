// Where outside data comes from: TypeScript's lib, the project's own declarations
// and settings, and `any` that libraries declare.
import { afterAll, describe, expect, it } from "vitest";
import { readSeamConfig } from "../src/config.js";
import { check, cleanup } from "./helpers.js";

afterAll(cleanup);

const codes = (files: Record<string, string>, options?: Parameters<typeof check>[1]) =>
  check(files, options).diagnostics.map((d) => [d.file.split("/").pop(), d.line, d.code]);

describe("TypeScript's lib", () => {
  // Each expression is outside data, so assigning it to string is TypeScript's error on an Unknown.
  it.each([
    ["IndexedDB request", "(r as IDBRequest).result"],
    ["IndexedDB cursor", "(c as IDBCursorWithValue).value"],
    ["clipboard", "await navigator.clipboard.readText()"],
    ["drag and drop", "(e as DragEvent).dataTransfer!.getData('text')"],
    ["a file", "await (f as File).text()"],
    ["a FileReader", "(fr as FileReader).result"],
    ["a response's text", "await (await fetch('/x')).text()"],
    ["the URL fragment", "location.hash"],
    ["history state", "history.state"],
    ["cookies", "document.cookie"],
    ["another tab's storage", "(se as StorageEvent).newValue"],
  ])("%s", (_, expr) => {
    const source = `export async function f(r: unknown, c: unknown, e: unknown, f: unknown, fr: unknown, se: unknown) {\n  const x: string | null = ${expr};\n  return x;\n}\n`;
    expect(codes({ "a.seam.ts": source })).toEqual([["a.seam.ts", 2, "TS2322"]]);
  });

  it("lets each be decoded", () => {
    const source = [
      "export async function f(e: DragEvent, file: File) {",
      "  decode string from location.hash;",
      "  decode string from document.cookie;",
      "  decode string from await navigator.clipboard.readText();",
      "  decode string from e.dataTransfer!.getData('text');",
      "  decode string[] from json await file.text();",
      "}",
      "",
    ].join("\n");
    expect(codes({ "a.seam.ts": source })).toEqual([]);
  });

  it("does not mark writes", () => {
    expect(codes({ "a.seam.ts": "location.hash = '#a';\ndocument.cookie = 'a=1';\ndocument.cookie += ';b=2';\n" })).toEqual([]);
  });
});

describe("sources the project declares", () => {
  it("are any function or value typed Unknown, with no settings", () => {
    const source = [
      "declare function readBridge(): Unknown;",
      "declare const bridge: { message(): Promise<Unknown> };",
      "export async function f() {",
      "  const a: string = readBridge();",
      "  const b = decode string from await bridge.message();",
      "  return [a, b];",
      "}",
      "",
    ].join("\n");
    expect(codes({ "a.seam.ts": source })).toEqual([["a.seam.ts", 4, "TS2322"]]);
  });

  it('are listed in "sources" when their types cannot be changed', () => {
    const files = {
      "bridge.d.ts": "declare const Android: { getData(): string; version: string; other(): string };\ndeclare function readBridge(): Promise<string>;\n",
      "a.seam.ts": [
        "export async function f() {",
        "  const a: string = Android.getData();",
        "  const b: string = Android.version;",
        "  const c: string = await readBridge();",
        "  const d: string = Android.other();",
        "  const ok = decode string from await readBridge();",
        "  return [a, b, c, d, ok];",
        "}",
        "",
      ].join("\n"),
    };
    const sources = ["Android.getData", "Android.version", "readBridge"];
    expect(codes(files, { checker: { sources } })).toEqual([
      ["a.seam.ts", 2, "TS2322"],
      ["a.seam.ts", 3, "TS2322"],
      ["a.seam.ts", 4, "TS2322"],
    ]);
    expect(codes(files)).toEqual([]);
  });
});

describe("any declared by a library", () => {
  const http = {
    "node_modules/fakehttp/package.json": '{ "name": "fakehttp", "types": "index.d.ts" }',
    "node_modules/fakehttp/index.d.ts": [
      "export interface Res<T = any> { data: T; status: number }",
      "export function get<T = any>(url: string): Promise<Res<T>>;",
      "export function raw(): any;",
      "export const config: any;",
      "",
    ].join("\n"),
  };
  const use = (body: string) => ({
    ...http,
    "a.seam.ts": `import { get, raw, config } from "fakehttp";\nboundary P { a: string }\nexport async function f() {\n${body}\n}\n`,
  });

  it.each([
    ["a response body", "  const r = await get('/x');\n  return r.data.a;"],
    ["a function returning any", "  return raw().a;"],
    ["a value typed any", "  return config.a;"],
  ])("rejects %s used as is (SEAM2005)", (_, body) => {
    expect(codes(use(body)).map(([, , code]) => code)).toEqual(["SEAM2005"]);
  });

  it("accepts it decoded, typed by the caller, or the project's own any", () => {
    const body = [
      "  const r = await get('/x');",
      "  const p = decode P from r.data;",
      "  const typed = (await get<{ a: string }>('/x')).data.a;",
      "  const status: number = r.status;",
      "  const mine: any = 1;",
      "  return [p, typed, status, mine.a];",
    ].join("\n");
    expect(codes(use(body))).toEqual([]);
  });

  it("leaves JSX tag names alone (asking about them would invent errors)", () => {
    const files = { ...http, "a.seam.tsx": 'import { config } from "fakehttp";\nconst r = decode string from config;\nexport const v = <div><span title={r.ok ? r.value : ""}>x</span></div>;\n' };
    expect(codes(files).filter(([, , c]) => c !== "TS2875" && c !== "TS2307")).toEqual([]);
  });

  it('is let through with "externalAny": "allow"', () => {
    expect(codes(use("  return raw().a;"), { checker: { externalAny: "allow" } })).toEqual([]);
  });
});

it("reads the settings and reports mistakes in them", () => {
  expect(readSeamConfig({ sources: ["A.b", "c"], externalAny: "allow" })).toEqual({ config: { sources: ["A.b", "c"], externalAny: "allow" }, errors: [] });
  expect(readSeamConfig(undefined)).toEqual({ config: {}, errors: [] });
  expect(readSeamConfig({ sources: ["a b"], externalAny: "no", extra: 1 }).errors).toHaveLength(3);
  expect(readSeamConfig([]).errors).toHaveLength(1);
});
