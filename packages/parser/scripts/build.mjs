// Bundles the fork into dist/index.js.
//
// Upstream builds with Babel and two build-time transforms that esbuild lacks;
// both are replicated here so the bundle behaves like the published @babel/parser:
//  - process.env.IS_PUBLISH = true selects the published code paths;
//  - `@bit` accessors in tokenizer/state.ts become getters/setters over one
//    bitfield (scripts/babel-plugin-bit-decorator in the Babel repository).
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const bitDecorator = {
  name: "bit-decorator",
  setup(b) {
    b.onLoad({ filter: /tokenizer[\\/]state\.ts$/ }, async ({ path }) => {
      let source = await readFile(path, "utf8");
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
      return { contents: source, loader: "ts" };
    });
  },
};

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  define: { "process.env.IS_PUBLISH": "true" },
  plugins: [bitDecorator],
  logLevel: "warning",
});
