import seamscript from "@seamscript/compiler/vite";
import { defineConfig } from "vite";

const backend = process.env["SANDBOX_BACKEND"] ?? "127.0.0.1:8790";

export default defineConfig({
  // Served by the sandbox backend under /voice/, next to the dashboard.
  base: "/voice/",
  plugins: [seamscript()],
  // The AudioWorklet module is bundled like a worker, so it needs the plugin too.
  worker: { format: "es", plugins: () => [seamscript()] },
  server: { proxy: { "/voice/echo": { target: `ws://${backend}`, ws: true } } },
  build: { target: "es2022" },
});
