// End to end: a production `vite build` of a .seam.ts app bundles the WASM core,
// and the core is installed before the app's own code runs.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, expect, it } from "vitest";
import seamscript from "../src/vite.js";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

it("a production build runs Text on the WASM core", async () => {
  const [entry] = project({
    "app/main.seam.ts":
      "export const report = {\n" +
      "  deterministic: Text.deterministic,\n" +
      "  unicodeVersion: Text.unicodeVersion,\n" +
      "  family: Text.length(Text.nfc('👨‍👩‍👧‍👦')),\n" +
      "};\n",
  });
  const outDir = join(dirname(entry!), "dist");
  await build({
    root: dirname(entry!),
    logLevel: "silent",
    configFile: false,
    plugins: [seamscript()],
    build: { outDir, target: "es2022", minify: false, lib: { entry: entry!, formats: ["es"], fileName: "main" } },
  });
  const { report } = await import(pathToFileURL(join(outDir, "main.js")).href);
  expect(report).toEqual({ deterministic: true, unicodeVersion: "17.0.0", family: 1 });
});

it("a build fails on a SeamScript error instead of bundling the plain TypeScript it was turned into", async () => {
  const [entry] = project({
    "app/main.seam.ts": "export function f() {\n  boundary Inside { a: string }\n  return Inside;\n}\n",
  });
  const outDir = join(dirname(entry!), "dist");
  const built = build({
    root: dirname(entry!),
    logLevel: "silent",
    configFile: false,
    plugins: [seamscript()],
    build: { outDir, target: "es2022", lib: { entry: entry!, formats: ["es"], fileName: "main" } },
  });
  await expect(built).rejects.toThrow(/SEAM1102/);
  expect(existsSync(join(outDir, "main.js"))).toBe(false);
});

async function bundle(files: Record<string, string>, core?: boolean | "deferred") {
  const paths = project(files);
  const entry = paths[0]!;
  const outDir = join(dirname(entry), "dist");
  await build({
    root: dirname(entry),
    logLevel: "silent",
    configFile: false,
    plugins: [seamscript({ core })],
    build: { outDir, target: "es2022", minify: false, lib: { entry, formats: ["es"], fileName: "main" } },
  });
  return { outDir, module: await import(pathToFileURL(join(outDir, "main.js")).href) };
}

it("with core: 'deferred', the app runs at once and Text works after Text.ready", async () => {
  const { module } = await bundle(
    {
      "main.seam.ts":
        "export const before = Text.status;\n" +
        "export const report = Text.ready.then(() => ({ status: Text.status, family: Text.length(Text.nfc('👨‍👩‍👧‍👦')) }));\n",
    },
    "deferred",
  );
  expect(module.before).toBe("loading");
  expect(await module.report).toEqual({ status: "core", family: 1 });
});

it("an app that does not use Text at run time leaves the core out of the bundle", async () => {
  const { outDir, module } = await bundle({
    "main.seam.ts": "boundary P { id: Int64, memo: string }\nexport const r = decode P from json '{\"id\": 1, \"memo\": \"x\"}';\n",
  });
  expect(module.r).toEqual({ ok: true, value: { id: 1n, memo: "x" } });
  const { readFileSync } = await import("node:fs");
  // "\0asm", the start of every WebAssembly module, in base64.
  expect(readFileSync(join(outDir, "main.js"), "utf8")).not.toContain("AGFzbQ");
  const withText = await bundle({ "main.seam.ts": "export const n = Text.length(Text.nfc('x'));\n" });
  expect(readFileSync(join(withText.outDir, "main.js"), "utf8")).toContain("AGFzbQ");
});
