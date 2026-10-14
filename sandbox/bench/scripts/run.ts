// node scripts/run.ts [--quick] [--no-build] [--only micro,latency,startup,check,bundle]
//                     [--browsers chromium,webkit]
// Run inside sandbox/e2e/shell.nix (it provides the browsers). Writes
// results/results.json (parts not run are kept from the previous file) and
// results/report.md.
//
// Firefox is left out by default: Playwright's Firefox build runs WebAssembly
// about 5x slower than Mozilla's own build of a newer Firefox on the same machine
// (DECISIONS.md), so its numbers describe the test browser, not what users get.
// `--browsers firefox` still measures it for reference; budgets ignore it.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { bundle } from "./bundle.ts";
import { checkTime } from "./checktime.ts";
import { latency } from "./latency.ts";
import { benchDir, type BrowserName, log, run, sandbox } from "./lib.ts";
import { micro } from "./micro.ts";
import { report } from "./report.ts";
import { startup } from "./startup.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const quick = flag("--quick");
const parts = new Set((value("--only") ?? "micro,latency,startup,check,bundle").split(","));
const browsers = (value("--browsers") ?? "chromium,webkit").split(",") as BrowserName[];

if (!flag("--no-build")) {
  const vite = join(sandbox, "../node_modules/.bin/vite");
  log("build: app (with and without the core), TS twin, bench");
  run(vite, ["build"], join(sandbox, "app"));
  run(vite, ["build", "--mode", "no-core"], join(sandbox, "app"));
  run(vite, ["build"], join(sandbox, "app-ts"));
  run(process.execPath, ["scripts/fixtures.ts"], benchDir);
  for (const mode of ["core", "host", "browser"]) run(vite, ["build", "--mode", mode], benchDir);
}

const file = join(benchDir, "results/results.json");
mkdirSync(join(benchDir, "results"), { recursive: true });
const results: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

results["meta"] = {
  date: new Date().toISOString(),
  quick,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  commit: execSync("git rev-parse --short HEAD", { cwd: sandbox, encoding: "utf8" }).trim(),
  dirty: execSync("git status --porcelain", { cwd: sandbox, encoding: "utf8" }).trim() !== "",
  // Other programs on the machine move absolute times (ratios much less): recorded with the run.
  loadAtStart: loadavg()[0],
};

// Saved after every part, so a part that fails or is interrupted loses only itself.
const save = () => {
  writeFileSync(file, JSON.stringify(results, null, 2));
  writeFileSync(join(benchDir, "results/report.md"), report(results));
};

if (parts.has("bundle")) {
  results["bundle"] = bundle();
  save();
}
if (parts.has("check")) {
  results["checkTime"] = checkTime(quick ? { runs: 3, warmup: 1 } : { runs: 10, warmup: 2 });
  save();
}
if (parts.has("startup")) {
  results["startup"] = await startup({ browsers, loads: quick ? 5 : 20, nodeRuns: quick ? 5 : 20 });
  save();
}
if (parts.has("latency")) {
  results["latency"] = await latency({
    browsers,
    rates: quick ? { frame: [50, 1000], each: [50] } : { frame: [50, 500, 2000], each: [50, 500, 1000] },
    warmupMs: quick ? 1500 : 2000,
    windowMs: quick ? 3000 : 6000,
    rounds: quick ? 1 : 2,
  });
  save();
}
if (parts.has("micro")) {
  results["micro"] = await micro({ browsers, timeoutMs: quick ? 5 * 60_000 : 10 * 60_000, save: (m) => ((results["micro"] = m), save()) });
  save();
}
(results["meta"] as Record<string, unknown>)["loadAtEnd"] = loadavg()[0];
save();
log(`wrote ${file} and results/report.md`);
