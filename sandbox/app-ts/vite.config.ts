import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env["SANDBOX_BACKEND"] ?? "127.0.0.1:8790";

// Served under /ts/ next to the SeamScript build.
export default defineConfig({
  base: "/ts/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://${backend}`,
      "/ws": { target: `ws://${backend}`, ws: true },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
