import { defineConfig } from "vitest/config";

export default defineConfig({
  // The differential test parses ~6,000 upstream fixtures four ways.
  test: { testTimeout: 120_000 },
});
