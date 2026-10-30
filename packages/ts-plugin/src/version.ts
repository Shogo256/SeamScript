// The TypeScript seamc checks with is pinned by @seamscript/compiler; the plugin
// runs on whatever TypeScript the editor's tsserver is. Different versions can
// report different type errors, so the plugin says so when they differ.

/** Replaced at build time (scripts/build.mjs) with the compiler's pinned TypeScript version. */
declare const __SEAMC_TYPESCRIPT__: string;

export const SEAMC_TYPESCRIPT: string = typeof __SEAMC_TYPESCRIPT__ === "string" ? __SEAMC_TYPESCRIPT__ : "unknown";

const majorMinor = (version: string) => /^(\d+)\.(\d+)/.exec(version)?.slice(1, 3).join(".");

/**
 * The warning to show when the editor's TypeScript is not the one seamc checks
 * with, or undefined when they match. Patch releases don't change what is
 * reported, so only the major and minor versions are compared.
 */
export function typescriptMismatch(editor: string, seamc: string = SEAMC_TYPESCRIPT): string | undefined {
  const a = majorMinor(editor);
  const b = majorMinor(seamc);
  if (a === undefined || b === undefined || a === b) return undefined;
  return (
    `This editor runs TypeScript ${editor}, but seamc checks with TypeScript ${seamc}, so the type errors shown here can differ from \`seamc check\`. ` +
    `Have the editor use the workspace's TypeScript ${b} (in VS Code: "TypeScript: Select TypeScript Version").`
  );
}
