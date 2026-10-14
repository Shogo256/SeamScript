// node scripts/check-budgets.ts: exits 1 when results/results.json exceeds budgets.json.
import { appendFileSync, readFileSync } from "node:fs";
import { evaluate } from "./budgets.ts";

const results = JSON.parse(readFileSync(new URL("../results/results.json", import.meta.url), "utf8")) as Record<string, unknown>;
const verdicts = evaluate(results);
for (const v of verdicts) console.log(`${v.ok ? "ok  " : "OVER"}  ${v.name}: ${v.actual} (limit ${v.limit})`);
const over = verdicts.filter((v) => !v.ok);

// On GitHub Actions, over-budget items also become annotations and the step
// summary gets the whole table, so a failure can be read without the job log.
if (process.env["GITHUB_ACTIONS"] === "true") {
  const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const v of over) console.log(`::error title=Budget exceeded::${escape(`${v.name}: ${v.actual} (limit ${v.limit})`)}`);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    const rows = verdicts.map((v) => `| ${v.name} | ${v.actual} | ${v.limit} | ${v.ok ? "OK" : "Over"} |`);
    appendFileSync(summary, ["## Budgets", "", "| Item | Measured | Limit | Result |", "|---|---|---|---|", ...rows, ""].join("\n"));
  }
}
if (verdicts.length === 0) {
  console.error("no results to check");
  process.exit(2);
}
process.exit(over.length > 0 ? 1 : 0);
