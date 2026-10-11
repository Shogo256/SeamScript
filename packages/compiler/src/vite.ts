import type { Plugin } from "vite";
import { formatDiagnostic } from "./diagnostics.js";
import { isSeamFile, transform } from "./transform.js";

/**
 * Compiles `.seam.ts` / `.seam.tsx` modules before Vite strips their types.
 * Like Vite itself, it does not type-check; run `seamc check` for that.
 */
export default function seamscript(): Plugin {
  return {
    name: "seamscript",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?", 1)[0]!;
      if (!isSeamFile(file)) return null;
      const r = transform(code, file);
      const errors = r.diagnostics.filter((d) => d.category === "error");
      if (errors.length > 0) this.error(errors.map(formatDiagnostic).join("\n"));
      return { code: r.code, map: r.map };
    },
  };
}
