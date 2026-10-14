import { fileURLToPath } from "node:url";
import seamscript from "@seamscript/compiler/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env["SANDBOX_BACKEND"] ?? "127.0.0.1:8790";
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig(({ mode }) => ({
  // `--mode no-core` builds without the WASM core, to measure what it adds. It is
  // served under /no-core/ next to the real build.
  base: mode === "no-core" ? "/no-core/" : "/",
  plugins: [seamscript(mode === "no-core" ? { core: false } : {}), react()],
  server: {
    proxy: {
      "/api": `http://${backend}`,
      "/ws": { target: `ws://${backend}`, ws: true },
      "/ucd": `http://${backend}`,
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: mode === "no-core" ? "dist-no-core" : "dist",
    rolldownOptions: { input: { main: page("index.html"), conformance: page("conformance.html") } },
  },
}));
