import seamscript from "@seamscript/compiler/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [seamscript()],
  // Test 1 runs seamc.
  test: { testTimeout: 60_000 },
});
