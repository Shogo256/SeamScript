// Golden tests: what seamc emits and reports, for whole projects, compared with
// files committed under test/golden/expected. SeamScript is responsible for
// exactly these two things (bundlers turn the emitted TypeScript into JavaScript),
// so any change to either shows up here as a diff before a release.
//
// After an intended change, regenerate the expected files and review the diff:
//   UPDATE_GOLDEN=1 yarn workspace @seamscript/compiler vitest run test/golden.test.ts
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readSeamConfig } from "../src/config.js";
import { formatDiagnostic } from "../src/diagnostics.js";
import { createSeamProgram } from "../src/program.js";

const repo = new URL("../../../", import.meta.url).pathname;
const expectedDir = new URL("./golden/expected/", import.meta.url).pathname;
const update = process.env["UPDATE_GOLDEN"] === "1";

/** Projects whose output is pinned: the curated cases, and the code written in SeamScript in this repository. */
const PROJECTS: Record<string, string> = {
  cases: "packages/compiler/test/golden/cases/tsconfig.json",
  "sandbox-app": "sandbox/app/tsconfig.json",
  "sandbox-voice": "sandbox/voice/tsconfig.json",
  demo: "demo/seamscript/tsconfig.json",
};

/** What seamc build --production writes for each `.seam.ts` file, and everything seamc check reports. */
function run(configPath: string): { outputs: Map<string, string>; diagnostics: string } {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(repo, configPath), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
  const seam = readSeamConfig((parsed.raw as { seamscript?: unknown }).seamscript);
  expect(seam.errors).toEqual([]);
  const p = createSeamProgram(parsed.fileNames, parsed.options, undefined, { production: true, checker: seam.config });
  const outputs = new Map<string, string>();
  for (const [file, r] of p.outputs) {
    if (file.startsWith(repo) && !file.includes("/node_modules/")) outputs.set(relative(dirname(join(repo, configPath)), file), r.code);
  }
  const diagnostics = p
    .diagnostics()
    .map((d) => ({ ...d, file: d.file && relative(repo, d.file) }))
    .sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code) || a.message.localeCompare(b.message))
    .map(formatDiagnostic)
    .join("\n");
  return { outputs, diagnostics: diagnostics === "" ? "" : `${diagnostics}\n` };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

describe.each(Object.entries(PROJECTS))("%s", (name, configPath) => {
  it("emits and reports exactly what was recorded", () => {
    const { outputs, diagnostics } = run(configPath);
    const dir = join(expectedDir, name);
    const actual = new Map<string, string>([...[...outputs].map(([f, code]) => [`${f}.golden`, code] as const), ["diagnostics.txt", diagnostics]]);
    if (update) {
      rmSync(dir, { recursive: true, force: true });
      for (const [file, text] of actual) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      return;
    }
    // The same set of files: a new or vanished output is a change too.
    expect(filesUnder(dir).sort(), `files under test/golden/expected/${name}`).toEqual([...actual.keys()].sort());
    for (const [file, text] of actual) {
      expect(text, `test/golden/expected/${name}/${file}`).toBe(readFileSync(join(dir, file), "utf8"));
    }
  });
});
