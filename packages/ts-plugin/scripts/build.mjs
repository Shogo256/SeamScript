// Bundles the plugin and everything it uses (the compiler's transform and
// checker, the parser fork, Volar) into one CommonJS file, which is what
// tsserver loads with require(). TypeScript itself is not bundled: tsserver
// hands the plugin its own instance.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// The TypeScript seamc pins, which the plugin compares with the editor's (src/version.ts).
const compiler = JSON.parse(readFileSync(new URL("../../compiler/package.json", import.meta.url), "utf8"));
const seamcTypescript = compiler.dependencies.typescript;
if (!/^\d+\.\d+\.\d+$/.test(seamcTypescript)) throw new Error(`@seamscript/compiler must pin an exact TypeScript version, not ${seamcTypescript}`);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  // tsserver calls the module itself: module.exports must be the factory.
  footer: { js: "module.exports = module.exports.default;" },
  define: { __SEAMC_TYPESCRIPT__: JSON.stringify(seamcTypescript) },
  logLevel: "warning",
});
