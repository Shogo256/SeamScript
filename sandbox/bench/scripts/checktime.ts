// `seamc check` against `tsc --noEmit` on the same program, with hyperfine.
//
// The same program: seamc build writes each .seam.ts as the plain TypeScript it
// checks, into bench/.tmp/app-plain (inside the repository, so node_modules
// resolves). tsc on that output is what checking would cost without SeamScript's
// second pass and boundary checks. The TypeScript twin app is timed as well.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchDir, log, run, sandbox } from "./lib.ts";

export interface CheckTimeResult {
  /** Seconds. */
  commands: Record<string, { mean: number; stddev: number; median: number; min: number; max: number; runs: number }>;
}

export function checkTime(options: { runs: number; warmup: number }): CheckTimeResult {
  const plain = join(benchDir, ".tmp/app-plain");
  rmSync(plain, { recursive: true, force: true });
  mkdirSync(plain, { recursive: true });
  const seamc = join(sandbox, "../node_modules/.bin/seamc");
  const tsc = join(sandbox, "../node_modules/.bin/tsc");
  run(seamc, ["build", "-p", "app/tsconfig.json", "--outDir", plain]);
  const config = JSON.parse(readFileSync(join(sandbox, "app/tsconfig.json"), "utf8")) as { include: string[] };
  config.include = ["."];
  writeFileSync(join(plain, "tsconfig.json"), JSON.stringify(config, null, 2));
  cpSync(join(sandbox, "app/src/styles.css"), join(plain, "styles.css"));
  run(tsc, ["-p", join(plain, "tsconfig.json")]); // must type-check cleanly before it is timed

  const commands = {
    "seamc check (app)": `${seamc} check -p ${join(sandbox, "app/tsconfig.json")}`,
    "tsc --noEmit (app, as plain TS)": `${tsc} -p ${join(plain, "tsconfig.json")}`,
    "tsc --noEmit (TS + Zod twin)": `${tsc} -p ${join(sandbox, "app-ts/tsconfig.json")}`,
  };
  const json = join(benchDir, ".tmp/hyperfine.json");
  log("check time: hyperfine");
  run("hyperfine", [
    "--warmup",
    String(options.warmup),
    "--runs",
    String(options.runs),
    "--export-json",
    json,
    ...Object.entries(commands).flatMap(([name, cmd]) => ["-n", name, cmd]),
  ]);
  const r = JSON.parse(readFileSync(json, "utf8")) as { results: { command: string; mean: number; stddev: number; median: number; min: number; max: number; times: number[] }[] };
  return {
    commands: Object.fromEntries(r.results.map((x) => [x.command, { mean: x.mean, stddev: x.stddev, median: x.median, min: x.min, max: x.max, runs: x.times.length }])),
  };
}
