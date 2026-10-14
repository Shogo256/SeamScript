// Bundles the plugin and everything it uses (the compiler's transform and
// checker, the parser fork, Volar) into one CommonJS file, which is what
// tsserver loads with require(). TypeScript itself is not bundled: tsserver
// hands the plugin its own instance.
import { build } from "esbuild";

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
  logLevel: "warning",
});
