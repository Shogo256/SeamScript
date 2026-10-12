import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// typescript-eslint's recommended preset, where most projects start.
// The rule that would stop bug 1, no-unsafe-type-assertion, is in no preset
// except "all", and needs type-aware linting on top.
export default defineConfig(tseslint.configs.recommended);
