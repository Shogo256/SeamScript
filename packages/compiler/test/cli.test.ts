import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import ts from "typescript";
import { about, main } from "../src/cli.js";
import seamscript from "../src/vite.js";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

const quiet = () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return errors;
};

it("check: exit 0 when clean, 1 with diagnostics", () => {
  const errors = quiet();
  const [good, bad] = project({
    "good.seam.ts": "export boundary P { n: number }\n",
    "bad.seam.ts": "export const s = (v: Unknown) => v as string;\n",
  });
  expect(main(["check", good!])).toBe(0);
  expect(main(["check", bad!])).toBe(1);
  expect(errors.join("\n")).toMatch(/bad\.seam\.ts\(1,34\): error SEAM2001/);
  vi.restoreAllMocks();
});

it("build: writes plain TypeScript under the same file name", () => {
  quiet();
  const [file] = project({ "src/order.seam.ts": "export boundary Order { id: Int64 }\n" });
  const outDir = join(dirname(file!), "..", "out");
  expect(main(["build", "--outDir", outDir, file!])).toBe(0);
  expect(readFileSync(join(outDir, "order.seam.ts"), "utf8")).toContain("export const Order: __ObjectDecoder<Order>");
  vi.restoreAllMocks();
});

it("build writes nothing at all when there is a SeamScript error, even in another file", () => {
  const errors = quiet();
  // A rejected construct is still turned into plain TypeScript for the type check
  // (a placeholder `null!` constant for the boundary); none of that may be written.
  const [good, bad] = project({
    "src/good.seam.ts": "export boundary Order { id: Int64 }\n",
    "src/bad.seam.ts": "export function f() {\n  boundary Inside { a: string }\n  return Inside;\n}\nexport latest async function* g() { yield 1; }\n",
  });
  const outDir = join(dirname(good!), "..", "out-failed");
  expect(main(["build", "--production", "--outDir", outDir, good!, bad!])).toBe(1);
  expect(existsSync(outDir)).toBe(false);
  expect(errors.join("\n")).toMatch(/bad\.seam\.ts\(2,3\): error SEAM1102[\s\S]*bad\.seam\.ts\(5,8\): error SEAM1401/);
  vi.restoreAllMocks();
});

it("build --production imports the WASM core, and type-checks against it", () => {
  quiet();
  const [file] = project({ "src/order.seam.ts": "export const t = Text.nfc('x');\n" });
  const outDir = join(dirname(file!), "..", "out-prod");
  expect(main(["build", "--production", "--outDir", outDir, file!])).toBe(0);
  expect(readFileSync(join(outDir, "order.seam.ts"), "utf8").split("\n")[0]).toBe('import "@seamscript/core";');
  const deferred = join(dirname(file!), "..", "out-deferred");
  expect(main(["build", "--production", "--defer-core", "--outDir", deferred, file!])).toBe(0);
  expect(readFileSync(join(deferred, "order.seam.ts"), "utf8").split("\n")[0]).toBe('import "@seamscript/core/deferred";');
  expect(main(["build", "--defer-core", "--outDir", deferred, file!])).toBe(2);
  vi.restoreAllMocks();
});

it("usage errors exit 2", () => {
  quiet();
  expect(main(["nope"])).toBe(2);
  expect(main(["build", "x.seam.ts"])).toBe(2);
  vi.restoreAllMocks();
});

it("help and version: exit 0, with the logo only on a terminal", () => {
  quiet();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const argv of [[], ["--help"], ["-h"], ["help"], ["--version"], ["-v"]]) expect(main(argv)).toBe(0);
  expect(log).toHaveBeenCalledTimes(6);
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const line = `seamc ${version} (TypeScript ${ts.version})`;
  expect(about("version", false)).toBe(line);
  expect(about("help", false)).toMatch(new RegExp(`^${line.replace(/[().]/g, "\\$&")}\\n.*\\n\\nUsage:`));
  const logo = about("version", true).split("\n");
  expect(logo).toHaveLength(8);
  expect(logo[5]).toMatch(/^(- )+\/_\/( -)+$/);
  expect(logo[7]).toBe(line);
  expect(about("help", true)).toContain("Usage:");
  vi.restoreAllMocks();
});

it("vite plugin: imports the WASM core in builds, not on the dev server, unless told otherwise", () => {
  const output = (command: "build" | "serve", core?: boolean | "deferred") => {
    const plugin = seamscript({ core });
    (plugin.configResolved as (c: object) => void)({ command, mode: "staging" });
    return (plugin.transform as (code: string, id: string) => { code: string }).call({}, "Text.nfc(u);", "/a.seam.ts").code;
  };
  expect(output("build")).toContain('import "@seamscript/core";');
  expect(output("serve")).not.toContain("@seamscript/core");
  expect(output("build", false)).not.toContain("@seamscript/core");
  expect(output("serve", true)).toContain('import "@seamscript/core";');
  expect(output("build", "deferred")).toContain('import "@seamscript/core/deferred";');
});

it("vite plugin: in a build, a plain module that uses Text imports the core too", () => {
  const plugin = seamscript();
  (plugin.configResolved as (c: object) => void)({ command: "build" });
  const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
  const helper = '"use client";\nimport { Text } from "@seamscript/runtime";\nexport const n = (s: string) => Text.length(Text.nfc(s));\n';
  expect(transform.call({}, helper, "/src/helper.ts")!.code).toBe(`"use client";\nimport "@seamscript/core";\n\nimport { Text } from "@seamscript/runtime";\nexport const n = (s: string) => Text.length(Text.nfc(s));\n`);
  expect(transform.call({}, "export const x = 1;", "/src/plain.ts")).toBeNull();
  expect(transform.call({}, 'import type { Text } from "@seamscript/runtime";\nexport type T = Text<"NFC">;', "/src/types.ts")).toBeNull();
});

it("vite plugin: compiles .seam.ts modules and leaves others", () => {
  const plugin = seamscript();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
  const ctx = { error: (msg: string) => { throw new Error(msg); } };
  expect(transform.call(ctx, "const r = decode P from v;", "/src/a.seam.ts?v=1")!.code).toContain("__decode(P, v)");
  expect(transform.call(ctx, "export {}", "/src/a.ts")).toBeNull();
  expect(() => transform.call(ctx, "boundary X { a: any }", "/src/b.seam.ts")).toThrow(/SEAM1101/);
});
