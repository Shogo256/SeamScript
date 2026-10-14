// node scripts/check-budgets.ts: exits 1 when results/results.json exceeds budgets.json.
import { readFileSync } from "node:fs";
import { evaluate } from "./budgets.ts";

const results = JSON.parse(readFileSync(new URL("../results/results.json", import.meta.url), "utf8")) as Record<string, unknown>;
const verdicts = evaluate(results);
for (const v of verdicts) console.log(`${v.ok ? "ok  " : "OVER"}  ${v.name}: ${v.actual} (limit ${v.limit})`);
const over = verdicts.filter((v) => !v.ok);
if (verdicts.length === 0) {
  console.error("no results to check");
  process.exit(2);
}
process.exit(over.length > 0 ? 1 : 0);
