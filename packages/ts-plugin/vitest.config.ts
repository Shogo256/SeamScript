import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each file starts a tsserver, whose first project load takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
