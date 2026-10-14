// The unplugin variants: each bundler builds the same .seam.ts project, and the
// bundle runs in Node with decode and the WASM core working.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build as esbuildBuild, transform as esbuildTransform } from "esbuild";
import { rolldown as rolldownBuild } from "rolldown";
import { rollup as rollupBuild } from "rollup";
import { afterAll, expect, it } from "vitest";
import webpackBuild from "webpack";
import { esbuild, rolldown, rollup, webpack } from "../src/unplugin.js";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

// The memo arrives decomposed (e + U+0301); decode normalizes it to NFC.
const files = {
  "src/order.seam.ts": "export boundary Order { id: Int64; memo: Text<NFC> }\n",
  "src/main.seam.ts": [
    'import { Order } from "./order.seam";',
    `const r = decode Order from JSON.parse('{"id":"9007199254740993","memo":"e\\\\u0301"}');`,
    "console.log(JSON.stringify({ ok: r.ok, id: r.ok ? String(r.value.id) : null, memo: r.ok ? r.value.memo : null, core: Text.status }));",
    "",
  ].join("\n"),
};
const expected = { ok: true, id: "9007199254740993", memo: "é", core: "core" };

function setup() {
  const [, main] = project(files);
  const dir = dirname(dirname(main!));
  return { dir, main: main!, out: join(dir, "out.mjs") };
}

const run = (file: string) => JSON.parse(execFileSync(process.execPath, [file], { cwd: dirname(file), encoding: "utf8" }));

// Rollup and webpack do not read TypeScript; projects give them a loader for it.
// The test's is esbuild's transform, which SeamScript's plugin must run before.
async function stripTypes(code: string, id: string) {
  return (await esbuildTransform(code, { loader: id.endsWith(".tsx") ? "tsx" : "ts", sourcefile: id, format: "esm" })).code;
}

it("esbuild", async () => {
  const { main, out } = setup();
  await esbuildBuild({ entryPoints: [main], bundle: true, format: "esm", platform: "node", outfile: out, plugins: [esbuild()], logLevel: "silent" });
  expect(run(out)).toEqual(expected);
});

it("Rolldown", async () => {
  const { main, out } = setup();
  const bundle = await rolldownBuild({ input: main, platform: "node", plugins: [rolldown()] });
  await bundle.write({ file: out, format: "es" });
  expect(run(out)).toEqual(expected);
});

it("Rollup", async () => {
  const { main, out } = setup();
  const bundle = await rollupBuild({
    input: main,
    // Rollup bundles only what it can resolve; the runtime and core stay imports.
    external: (id) => id.startsWith("@seamscript/"),
    plugins: [
      rollup(),
      {
        name: "test:typescript",
        resolveId: (source, importer) => {
          const file = importer && source.startsWith(".") ? resolve(dirname(importer), `${source}.ts`) : undefined;
          return file && existsSync(file) ? file : null;
        },
        transform: async (code, id) => (id.endsWith(".ts") ? { code: await stripTypes(code, id) } : null),
      },
    ],
  });
  await bundle.write({ file: out, format: "es" });
  expect(run(out)).toEqual(expected);
});

it("webpack", async () => {
  const { dir, main, out } = setup();
  const stats = await new Promise<webpackBuild.Stats>((done, fail) =>
    webpackBuild(
      {
        mode: "production",
        target: "node",
        entry: main,
        output: { path: dir, filename: "out.mjs", module: true, chunkFormat: "module" },
        experiments: { outputModule: true },
        resolve: { extensions: [".ts", ".js"] },
        module: { rules: [{ test: /\.ts$/, use: [{ loader: new URL("./strip-types-loader.cjs", import.meta.url).pathname }] }] },
        optimization: { minimize: false },
        plugins: [webpack()],
      },
      (error, s) => (error ? fail(error) : done(s!)),
    ),
  );
  expect(stats.toString({ all: false, errors: true })).toBe("");
  expect(run(out)).toEqual(expected);
}, 60_000);
