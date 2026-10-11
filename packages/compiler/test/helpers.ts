import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSeamProgram, defaultCompilerOptions } from "../src/program.js";

// Projects are written inside the repository so that "@seamscript/runtime"
// resolves through the workspace's node_modules.
export const TMP = new URL("./.tmp/", import.meta.url).pathname;
let counter = 0;

export function project(files: Record<string, string>): string[] {
  const dir = join(TMP, `p${process.pid}-${counter++}`);
  return Object.entries(files).map(([name, content]) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  });
}

export function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}

export function check(files: Record<string, string>) {
  const paths = project(files);
  const p = createSeamProgram(paths, defaultCompilerOptions);
  return { paths, p, diagnostics: p.diagnostics() };
}

/** `[line, code]` pairs, the compact form most tests compare. */
export function codesByLine(source: string, file = "a.seam.ts"): [number, string][] {
  return check({ [file]: source }).diagnostics.map((d) => [d.line, d.code]);
}
