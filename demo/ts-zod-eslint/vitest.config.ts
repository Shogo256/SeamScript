import { defineConfig } from "vitest/config";

// Test 1 runs tsc and ESLint.
export default defineConfig({ test: { testTimeout: 60_000 } });
