// Node.js sources of outside data, checked as a user runs them: seamc check in a
// subprocess, on a project whose types include @types/node.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

const seamc = new URL("../bin/seamc.js", import.meta.url).pathname;
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] },
  include: ["src"],
});

/** `[file, line, code]` for every diagnostic seamc check reports, and its exit code. */
function check(files: Record<string, string>): { status: number | null; diagnostics: [string, number, string][] } {
  const [config] = project({ "tsconfig.json": TSCONFIG, ...Object.fromEntries(Object.entries(files).map(([f, t]) => [`src/${f}`, t])) });
  const r = spawnSync(process.execPath, [seamc, "check", "-p", config!], { cwd: dirname(config!), encoding: "utf8" });
  const diagnostics = [...r.stderr.matchAll(/^src\/([^(]+)\((\d+),\d+\): error (\w+):/gm)].map((m) => [m[1]!, Number(m[2]), m[3]!] as [string, number, string]);
  return { status: r.status, diagnostics };
}

describe("process.env", () => {
  it("each variable read is Unknown: used as a string it is an error, decoded it is fine", () => {
    const r = check({
      "env.seam.ts": [
        'const port: string | undefined = process.env.PORT;',
        'const home = process.env["HOME"]!.length;',
        'export const parsed = decode Int64 from process.env.PORT;',
        'export const name = decode string from process.env[String("NAME")];',
        "export { port, home };",
        "",
      ].join("\n"),
    });
    expect(r.diagnostics).toEqual([
      ["env.seam.ts", 1, "TS2322"],
      ["env.seam.ts", 2, "TS2339"],
    ]);
    expect(r.status).toBe(1);
  });

  it("the whole of process.env is Unknown when it is taken whole, destructured or passed on", () => {
    const r = check({
      "whole.seam.ts": [
        "const env = process.env;",
        "export const port = env.PORT;",
        "const { HOME } = process.env;",
        "export const copy = { ...process.env };",
        "boundary Env { PORT: string, NODE_ENV?: \"development\" | \"production\" }",
        "export const config = decode Env from process.env;",
        "const { env: environment } = process;",
        "export { HOME, environment };",
        "",
      ].join("\n"),
    });
    expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["2:TS2339", "3:TS2339", "4:SEAM2001", "7:SEAM2004"]);
  });

  it("writing and deleting variables is not reading them", () => {
    const r = check({ "write.seam.ts": 'process.env.PORT = "8080";\nprocess.env["MODE"] ??= "dev";\ndelete process.env.TMP;\nexport {};\n' });
    expect(r.diagnostics).toEqual([]);
    expect(r.status).toBe(0);
  });
});

describe("files", () => {
  it("readFileSync's result is Unknown, from fs and node:fs, by member or by name", () => {
    const r = check({
      "sync.seam.ts": [
        'import fs from "node:fs";',
        'import { readFileSync } from "fs";',
        'const a: string = fs.readFileSync("a.txt", "utf8");',
        'const b = readFileSync("b.txt", "utf8").length;',
        'export const text = decode string from readFileSync("c.txt", "utf8");',
        'export const bytes = decode Bytes from fs.readFileSync("d.bin");',
        'export const config = decode string[] from json readFileSync("e.json", "utf8");',
        "export { a, b };",
        "",
      ].join("\n"),
    });
    expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["3:TS2322", "4:TS2339"]);
  });

  it("fs/promises readFile resolves to Unknown, through every import path", () => {
    const r = check({
      "promises.seam.ts": [
        'import { readFile } from "node:fs/promises";',
        'import * as fsp from "fs/promises";',
        'import fs from "node:fs";',
        "export async function load() {",
        '  const a: string = await readFile("a.txt", "utf8");',
        '  const b: string = await fsp.readFile("b.txt", "utf8");',
        '  const c: string = await fs.promises.readFile("c.txt", "utf8");',
        '  const d = decode string from await readFile("d.txt", "utf8");',
        "  return [a, b, c, d];",
        "}",
        "",
      ].join("\n"),
    });
    expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["5:TS2322", "6:TS2322", "7:TS2322"]);
  });

  it("fs.readFile's callback gets its data as Unknown", () => {
    const r = check({
      "callback.seam.ts": [
        'import fs from "node:fs";',
        'fs.readFile("a.txt", "utf8", (err, data) => {',
        "  if (err) throw err;",
        "  console.log(data.length);",
        "  const text = decode string from data;",
        "  if (text.ok) console.log(text.value.length);",
        "});",
        "export {};",
        "",
      ].join("\n"),
    });
    expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["4:TS2339"]);
  });

  it("a reference that can't be tracked is refused", () => {
    const r = check({ "ref.seam.ts": 'import fs from "node:fs";\nconst read = fs.readFileSync;\nexport const x = read("a.txt", "utf8");\n' });
    expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["2:SEAM2003"]);
  });
});

it("JSON.parse was already outside data, and stays so", () => {
  const r = check({ "json.seam.ts": 'export const name: string = JSON.parse("{}").name;\n' });
  expect(r.diagnostics.map(([, line, code]) => `${line}:${code}`)).toEqual(["1:TS2339"]);
});

it("plain .ts files are not affected", () => {
  const r = check({
    "plain.ts": ['import { readFileSync } from "node:fs";', 'export const port: string | undefined = process.env.PORT;', 'export const text: string = readFileSync("a.txt", "utf8");', ""].join("\n"),
  });
  expect(r.diagnostics).toEqual([]);
  expect(r.status).toBe(0);
});

it("a function of the project's own named like a Node one is not a source", () => {
  const r = check({ "own.seam.ts": 'function readFileSync(p: string): string { return p; }\nexport const s: string = readFileSync("a");\nconst process = { env: { PORT: "1" } };\nexport const p: string = process.env.PORT;\n' });
  expect(r.diagnostics).toEqual([]);
});

