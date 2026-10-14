import { fileURLToPath } from "node:url";
import seamscript from "@seamscript/compiler/vite";
import { defineConfig } from "vite";

// Three builds of the same suite:
//   --mode core     Node, with the WASM core (dist/node-core)
//   --mode host     Node, Text on Node's ICU (dist/node-host)
//   --mode browser  a page served at /bench/ (dist/browser), with the WASM core
export default defineConfig(({ mode }) => ({
  base: "/bench/",
  plugins: [seamscript({ core: mode !== "host" })],
  build:
    mode === "browser"
      ? { outDir: "dist/browser", target: "es2022", rolldownOptions: { input: fileURLToPath(new URL("bench.html", import.meta.url)) } }
      : { ssr: "src/node.seam.ts", outDir: `dist/node-${mode}`, target: "node24" },
}));
