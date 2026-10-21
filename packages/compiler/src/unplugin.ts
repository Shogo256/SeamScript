// The compiler as a plugin for other bundlers, through unplugin: esbuild, Rollup,
// Rolldown, webpack, Rspack, Rsbuild and Bun. The same job as ./vite.ts: compile
// `.seam.ts` / `.seam.tsx` modules to TypeScript before the bundler (or the
// loader the project already uses for TypeScript) strips the types. Like the
// bundlers themselves, it does not type-check; run `seamc check` for that.
import { createUnplugin, type UnpluginInstance } from "unplugin";
import { formatDiagnostic } from "./diagnostics.js";
import { addCoreImport } from "./core-import.js";
import { transform } from "./transform.js";

export interface SeamScriptUnpluginOptions {
  /**
   * Import `@seamscript/core` (the WASM core) into the modules that use Text at
   * run time, so Text is deterministic. Default: on. `"deferred"` imports
   * `@seamscript/core/deferred` instead (see the Vite plugin). These bundlers have no development
   * server to tell apart from a build (the Vite variant keeps Vite's rule: on
   * for `vite build`, off for the dev server and Vitest).
   */
  core?: boolean | "deferred";
}

const SEAM_MODULE = /\.seam\.tsx?(?:\?.*)?$/;
// .seam.ts modules, and plain ones that may use Text (see core-import.ts).
const SCRIPT_MODULE = /\.[cm]?[jt]sx?(?:\?.*)?$/;

export const seamscript: UnpluginInstance<SeamScriptUnpluginOptions | undefined, false> = createUnplugin((options = {}) => {
  let production = options.core !== false;
  const deferCore = options.core === "deferred";
  return {
    name: "seamscript",
    // Before the bundler's or the project's TypeScript handling.
    enforce: "pre",
    transform: {
      filter: { id: SCRIPT_MODULE },
      handler(code, id) {
        const file = id.split("?", 1)[0]!;
        if (!SEAM_MODULE.test(id)) return production ? addCoreImport(code, file, deferCore) : null;
        const r = transform(code, file, { production, deferCore });
        const errors = r.diagnostics.filter((d) => d.category === "error");
        if (errors.length > 0) this.error(errors.map(formatDiagnostic).join("\n"));
        return { code: r.code, map: r.map };
      },
    },
    vite: {
      configResolved(config) {
        production = options.core === undefined ? config.command === "build" : options.core !== false;
      },
    },
  };
});

export const esbuild = seamscript.esbuild;
export const rollup = seamscript.rollup;
export const rolldown = seamscript.rolldown;
export const webpack = seamscript.webpack;
export const rspack = seamscript.rspack;
export const rsbuild = seamscript.rsbuild;
export const bun = seamscript.bun;
export const vite = seamscript.vite;
