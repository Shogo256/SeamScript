// Runs both sides of the comparison demo and prints which bugs each one stops.
//
// Exits 0 when the demo shows what it is meant to: TypeScript + Zod + ESLint
// passes its own checks yet stops none of the three bugs, and SeamScript stops
// all three. Any other outcome means the demo no longer demonstrates anything.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bin = (pkg, path) => join(dirname(require.resolve(`${pkg}/package.json`)), path);
const node = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

const TS = join(here, "ts-zod-eslint");
const SEAM = join(here, "seamscript");
const vitest = bin("vitest", JSON.parse(readFileSync(bin("vitest", "package.json"), "utf8")).bin.vitest);

/** Test status by bug number ("1", "2", "3"), from vitest's JSON report. */
function runTests(dir) {
  const tmp = mkdtempSync(join(tmpdir(), "seamscript-demo-"));
  try {
    const out = join(tmp, "report.json");
    node(vitest, ["run", "--reporter=json", `--outputFile=${out}`], dir);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const status = new Map();
    for (const file of report.testResults) {
      for (const t of file.assertionResults) status.set(t.title.split(".")[0], t.status);
    }
    return status;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("SeamScript comparison demo: the same screen written in TypeScript strict + Zod + ESLint and in SeamScript,");
console.log("checking whether three bugs are stopped before they reach the user.\n");

const tsc = node(bin("typescript", "bin/tsc"), ["--noEmit", "-p", "."], TS);
const eslint = node(bin("eslint", "bin/eslint.js"), ["src"], TS);
const linted = tsc.status === 0 && eslint.status === 0;
console.log(`TS side, tsc --strict and ESLint (recommended): ${linted ? "✓ no errors" : "✗ errors"}\n`);

const ts = runTests(TS);
const seam = runTests(SEAM);

const BUGS = [
  ["1", "as Order via unknown", "passes tsc and ESLint", "stopped by SEAM2001"],
  ["2", "slice(0, 10) on an emoji memo", "splits a character", "no split"],
  ["3", "a stale response wins", "stale result shown", "latest result shown"],
];

// East Asian wide characters take two terminal columns.
const width = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));

const cell = (status, stopped, through) =>
  status === "passed" ? `✓ ${stopped}` : status === "failed" ? `✗ ${through}` : `? ${status ?? "not run"}`;

const rows = [["Bug", "TS + Zod + ESLint", "SeamScript"]];
for (const [n, name, tsThrough, seamStopped] of BUGS) {
  rows.push([`${n}. ${name}`, cell(ts.get(n), "stopped", tsThrough), cell(seam.get(n), seamStopped, "not stopped")]);
}
const cols = [0, 1, 2].map((i) => Math.max(...rows.map((r) => width(r[i]))) + 2);
for (const r of rows) console.log(r.map((c, i) => pad(c, cols[i])).join("").trimEnd());

console.log("\n✓ = stopped before it reaches the user   ✗ = reaches the user");
console.log("Bug 1 is also stopped on the TS side if you enable typescript-eslint's no-unsafe-type-assertion");
console.log("(not in recommended or strict, and it needs type-aware linting). SeamScript stops it regardless of configuration.");

const expected =
  linted && BUGS.every(([n]) => ts.get(n) === "failed") && BUGS.every(([n]) => seam.get(n) === "passed");
console.log(`\n${expected ? "As expected." : "Unexpected result (the TS side should pass its checks and let all three bugs through; SeamScript should stop all three)."}`);
process.exitCode = expected ? 0 : 1;
