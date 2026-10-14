// The micro-benchmark suite, shared by the Node and browser entries.
import { decodeCases, textCases } from "./cases.seam";
import { verifyZod, zodCases } from "./cases-zod";
import { bench, type Case, type Options, type Stats } from "./harness";

export interface SuiteResult {
  readonly text: { deterministic: boolean; unicode: string | null };
  readonly results: Stats[];
}

/** Every SeamScript decode case must decode its fixture; a failing case would time the error path. */
function verify(cases: readonly Case[]): void {
  for (const c of cases) {
    const r = c.fn();
    if (typeof r === "object" && r !== null && "ok" in r && r.ok === false) throw new Error(`${c.group} / ${c.name} failed to decode its fixture`);
  }
}

export async function runSuite(options: Options & { only?: "decode" | "text" } = {}): Promise<SuiteResult> {
  const cases: Case[] = [];
  if (options.only !== "text") {
    const seam = decodeCases();
    verify(seam);
    verifyZod();
    cases.push(...seam, ...zodCases());
  }
  if (options.only !== "decode") cases.push(...textCases());
  const results = await bench(cases, options);
  return { text: { deterministic: Text.deterministic, unicode: Text.unicodeVersion }, results };
}
