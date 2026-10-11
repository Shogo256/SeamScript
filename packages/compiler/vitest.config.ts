import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each check builds two TypeScript programs over lib.dom; a few seconds under parallel load.
  test: { testTimeout: 60_000 },
});
