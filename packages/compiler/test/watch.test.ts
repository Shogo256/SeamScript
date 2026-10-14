// seamc check --watch, run as the command it is (bin/seamc.js over dist/).
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cleanup, project } from "./helpers.js";

const seamc = new URL("../bin/seamc.js", import.meta.url).pathname;
let child: ChildProcess | undefined;
afterAll(() => {
  child?.kill();
  cleanup();
});

it("checks again when a file changes, reusing what did not", async () => {
  const [config, file] = project({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler", types: [] }, include: ["src"] }),
    "src/a.seam.ts": "export boundary P { n: number }\nexport const f = (v: Unknown) => decode P from v;\n",
  });
  let output = "";
  child = spawn(process.execPath, [seamc, "check", "--watch", "-p", config!], { cwd: dirname(config!) });
  child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
  const waitFor = async (pattern: RegExp, count: number) => {
    for (let i = 0; i < 300 && (output.match(new RegExp(pattern, "g"))?.length ?? 0) < count; i++) await new Promise((r) => setTimeout(r, 100));
    expect(output.match(new RegExp(pattern, "g"))?.length ?? 0, output).toBeGreaterThanOrEqual(count);
  };

  await waitFor(/Found 0 errors .* Watching for file changes\./, 1);
  writeFileSync(file!, "export const s = (v: Unknown) => v as string;\n");
  await waitFor(/Found 2 errors .* Watching/, 1); // SEAM2001 and TypeScript's TS2352
  expect(output).toMatch(/a\.seam\.ts\(1,34\): error SEAM2001/);
  writeFileSync(join(dirname(file!), "b.seam.ts"), "export const ok = 1;\n");
  writeFileSync(file!, "export const s = (v: Unknown) => Unknown.log(v);\n");
  await waitFor(/Found 0 errors .* Watching/, 2);
}, 60_000);
