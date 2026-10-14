// Bundles the fork into dist/index.js.
//
// Upstream builds with Babel and build-time transforms that esbuild lacks; they
// are replicated here so the bundle behaves, and performs, like the published
// @babel/parser:
//  - process.env.IS_PUBLISH = true selects the published code paths;
//  - `charCodes.x` becomes the number it names (babel-plugin-transform-charcodes).
//    Left as is, every one in the tokenizer's inner loops is a call to the getter
//    esbuild puts on a CommonJS module's exports, which made parsing several
//    times slower;
//  - `@bit` accessors in tokenizer/state.ts become getters/setters over one
//    bitfield (scripts/babel-plugin-bit-decorator in the Babel repository).
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

const charCodes = createRequire(import.meta.url)("charcodes");

function inlineCharCodes(source, path) {
  if (!source.includes("charcodes")) return source;
  const out = source
    // Type positions (`typeof charCodes`) still need the declarations; erased.
    .replace(/^import \* as charCodes from "charcodes";$/m, 'import type * as charCodes from "charcodes";')
    .replace(/\bcharCodes\.(\w+)\b/g, (_, name) => {
      if (typeof charCodes[name] !== "number") throw new Error(`${path}: charCodes.${name} is not a constant`);
      return String(charCodes[name]);
    });
  const rest = out.replace(/\/\/.*$/gm, "").replace(/typeof charCodes\b/g, "").replace(/^import type \* as charCodes from "charcodes";$/m, "");
  if (/charcodes|charCodes/.test(rest)) throw new Error(`${path}: unhandled charcodes usage`);
  return out;
}

const upstreamTransforms = {
  name: "upstream-transforms",
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, async ({ path }) => {
      let source = inlineCharCodes(await readFile(path, "utf8"), path);
      if (/tokenizer[\\/]state\.ts$/.test(path)) source = bitFields(source);
      return { contents: source, loader: "ts" };
    });
  },
};

function bitFields(source) {
  const storage = /@bit\.storage (\w+): number = 0;/.exec(source);
  if (!storage) throw new Error("state.ts: @bit.storage field not found");
  const field = storage[1];
  let mask = 1;
  let initial = 0;
  source = source.replace(/@bit accessor (\w+) = (true|false);/g, (_, name, value) => {
    if (mask === 0) throw new Error("state.ts: more than 32 @bit fields");
    if (value === "true") initial |= mask;
    const out =
      `get ${name}() { return (this.${field} & ${mask}) > 0; } ` +
      `set ${name}(v) { if (v) this.${field} |= ${mask}; else this.${field} &= ${~mask}; }`;
    mask <<= 1;
    return out;
  });
  source = source.replace(storage[0], `${field}: number = ${initial};`);
  if (source.includes("@bit")) throw new Error("state.ts: unhandled @bit usage");
  return source;
}

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  define: { "process.env.IS_PUBLISH": "true" },
  plugins: [upstreamTransforms],
  logLevel: "warning",
});
