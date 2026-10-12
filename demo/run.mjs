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

console.log("SeamScript 比較デモ: 同じ画面を TypeScript strict + Zod + ESLint と SeamScript で書き、");
console.log("3つのバグがユーザーに届く前に止まるかを調べます。\n");

const tsc = node(bin("typescript", "bin/tsc"), ["--noEmit", "-p", "."], TS);
const eslint = node(bin("eslint", "bin/eslint.js"), ["src"], TS);
const linted = tsc.status === 0 && eslint.status === 0;
console.log(`TS 側の tsc --strict と ESLint (recommended): ${linted ? "✓ エラーなし" : "✗ エラーあり"}\n`);

const ts = runTests(TS);
const seam = runTests(SEAM);

const BUGS = [
  ["1", "unknown 経由で as Order", "tsc・ESLint とも通過", "SEAM2001 で停止"],
  ["2", "絵文字を slice(0, 10) で切る", "文字が割れる", "割れない"],
  ["3", "古い応答で画面が戻る", "古い結果が残る", "最新の結果が残る"],
];

// East Asian wide characters take two terminal columns.
const width = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));

const cell = (status, stopped, through) =>
  status === "passed" ? `✓ ${stopped}` : status === "failed" ? `✗ ${through}` : `? ${status ?? "未実行"}`;

const rows = [["バグ", "TS + Zod + ESLint", "SeamScript"]];
for (const [n, name, tsThrough, seamStopped] of BUGS) {
  rows.push([`${n}. ${name}`, cell(ts.get(n), "止まる", tsThrough), cell(seam.get(n), seamStopped, "止まらない")]);
}
const cols = [0, 1, 2].map((i) => Math.max(...rows.map((r) => width(r[i]))) + 2);
for (const r of rows) console.log(r.map((c, i) => pad(c, cols[i])).join("").trimEnd());

console.log("\n✓ = ユーザーに届く前に止まる   ✗ = 止まらずに届く");
console.log("バグ1は、typescript-eslint の no-unsafe-type-assertion（recommended にも strict にも入っておらず、型情報つき lint が必要）を");
console.log("有効にすれば TS 側でも止まります。SeamScript では設定に依らず止まります。");

const expected =
  linted && BUGS.every(([n]) => ts.get(n) === "failed") && BUGS.every(([n]) => seam.get(n) === "passed");
console.log(`\n${expected ? "想定どおりの結果です。" : "想定と違う結果です（TS 側は検査を通過して3つとも素通り、SeamScript 側は3つとも停止のはず）。"}`);
process.exitCode = expected ? 0 : 1;
