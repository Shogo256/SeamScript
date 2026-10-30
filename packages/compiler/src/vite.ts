import type { Plugin } from "vite";
import { formatDiagnostic } from "./diagnostics.js";
import { addCoreImport } from "./core-import.js";
import { isSeamFile, transform } from "./transform.js";

/**
 * Compiles `.seam.ts` / `.seam.tsx` modules before Vite strips their types.
 * Like Vite itself, it does not type-check; run `seamc check` for that. A
 * production build fails if `@seamscript/core` cannot be resolved.
 */
export interface SeamScriptPluginOptions {
  /**
   * Import `@seamscript/core` (the WASM core) into the modules that use Text at
   * run time. Default: on for `vite build`, whatever its mode, and off for the dev
   * server and Vitest, which run Text on the host's ICU (Text.deterministic is
   * false). `"deferred"` imports `@seamscript/core/deferred`: start-up is not held
   * up, and the app awaits `Text.ready` before its first Text operation.
   */
  core?: boolean | "deferred";
}

export default function seamscript(options: SeamScriptPluginOptions = {}): Plugin {
  let production = false;
  return {
    name: "seamscript",
    enforce: "pre",
    // The dev server scans the app's modules for dependencies to pre-bundle with
    // Rolldown, outside the plugin pipeline: it has to be shown the TypeScript a
    // .seam.ts file compiles to, or it stops at the first `boundary` and skips
    // pre-bundling. Errors are left to the transform above, which reports them.
    config: () => ({
      optimizeDeps: {
        rolldownOptions: {
          plugins: [
            {
              name: "seamscript:scan",
              transform(code: string, id: string) {
                const file = id.split("?", 1)[0]!;
                return isSeamFile(file) ? { code: transform(code, file).code } : null;
              },
            },
          ],
        },
      },
    }),
    configResolved(config) {
      // Not config.isProduction: that follows NODE_ENV, which a test runner or a
      // staging build sets to something else while still building for real.
      production = options.core === undefined ? config.command === "build" : options.core !== false;
    },
    transform(code, id) {
      const file = id.split("?", 1)[0]!;
      const deferCore = options.core === "deferred";
      if (!isSeamFile(file)) return production ? addCoreImport(code, file, deferCore) : null;
      const r = transform(code, file, { production, deferCore });
      const errors = r.diagnostics.filter((d) => d.category === "error");
      if (errors.length > 0) this.error(errors.map(formatDiagnostic).join("\n"));
      return { code: r.code, map: r.map };
    },
  };
}
