import type { Plugin } from "vite";
import { formatDiagnostic } from "./diagnostics.js";
import { isSeamFile, transform } from "./transform.js";

/**
 * Compiles `.seam.ts` / `.seam.tsx` modules before Vite strips their types.
 * Like Vite itself, it does not type-check; run `seamc check` for that. A
 * production build fails if `@seamscript/core` cannot be resolved.
 */
export interface SeamScriptPluginOptions {
  /**
   * Import `@seamscript/core` (the WASM core) into every `.seam.ts` module.
   * Default: on for `vite build`, whatever its mode, and off for the dev server
   * and Vitest, which run Text on the host's ICU (Text.deterministic is false).
   */
  core?: boolean;
}

export default function seamscript(options: SeamScriptPluginOptions = {}): Plugin {
  let production = false;
  return {
    name: "seamscript",
    enforce: "pre",
    configResolved(config) {
      // Not config.isProduction: that follows NODE_ENV, which a test runner or a
      // staging build sets to something else while still building for real.
      production = options.core ?? config.command === "build";
    },
    transform(code, id) {
      const file = id.split("?", 1)[0]!;
      if (!isSeamFile(file)) return null;
      const r = transform(code, file, { production });
      const errors = r.diagnostics.filter((d) => d.category === "error");
      if (errors.length > 0) this.error(errors.map(formatDiagnostic).join("\n"));
      return { code: r.code, map: r.map };
    },
  };
}
