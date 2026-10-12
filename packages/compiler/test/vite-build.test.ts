// End to end: a production `vite build` of a .seam.ts app bundles the WASM core,
// and the core is installed before the app's own code runs.
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
