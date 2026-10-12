import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Part 1's invariant normalizes every code point twice.
    testTimeout: 120_000,
    // Processed by Vitest rather than loaded natively, so vi.resetModules() gives
    // each test a runtime without a core installed.
    server: { deps: { inline: ["@seamscript/runtime"] } },
  },
});
