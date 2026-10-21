import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSeamProgram, defaultCompilerOptions, type SeamProgramOptions } from "../src/program.js";

// Projects are written inside the repository so that "@seamscript/runtime"
// resolves through the workspace's node_modules.
export const TMP = new URL("./.tmp/", import.meta.url).pathname;
let counter = 0;
// Test files run in parallel; each removes only the projects it created.
const created: string[] = [];

export function project(files: Record<string, string>): string[] {
  const dir = join(TMP, `p${process.pid}-${counter++}`);
  created.push(dir);
  return Object.entries(files).map(([name, content]) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  });
}

export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function check(files: Record<string, string>, options: SeamProgramOptions = {}) {
  // Only source files are roots; others (a fake package under node_modules) are found by resolution.
  const paths = project(files).filter((f) => !f.includes("/node_modules/") && /\.tsx?$/.test(f));
  const p = createSeamProgram(paths, defaultCompilerOptions, undefined, options);
  return { paths, p, diagnostics: p.diagnostics() };
}

/** `[line, code]` pairs, the compact form most tests compare. */
export function codesByLine(source: string, file = "a.seam.ts"): [number, string][] {
  return check({ [file]: source }).diagnostics.map((d) => [d.line, d.code]);
}
