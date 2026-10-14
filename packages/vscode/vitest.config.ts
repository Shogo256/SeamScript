import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A tsserver loading the sandbox's app takes a few seconds.
    testTimeout: 60_000,
  },
});
