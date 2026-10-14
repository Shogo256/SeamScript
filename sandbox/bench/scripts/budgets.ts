// Budgets: each limit is a ratio to a baseline measured in the same run on the
// same machine (Zod, Intl, tsc, the TS twin, the build without the core), so
// a slower CI machine moves both sides and the check stays meaningful. The one
// absolute number is the core's size, which does not depend on the machine.
import { readFileSync } from "node:fs";
import type { BundleSize } from "./bundle.ts";
import type { CheckTimeResult } from "./checktime.ts";
import type { LatencyRun } from "./latency.ts";
import type { MicroRun } from "./micro.ts";
import type { StartupResult } from "./startup.ts";

export interface Budgets {
  /** SeamScript decode p50 ÷ Zod doing the same checks, per input, in Node. */
  decodeVsZodSameChecks: number;
  /** Text.length (uncached) p50 ÷ counting with Intl.Segmenter, Japanese and Khmer samples, in Node. */
  textLengthVsIntl: number;
  /**
   * Text.nfc p50 ÷ String.prototype.normalize, same samples, in Node. Japanese is
   * answered in JavaScript (about 1×); Khmer goes through WASM's quick check
   * (3 to 4×), which is what this limit holds.
   */
  textNfcVsNormalize: number;
  /** seamc check ÷ tsc --noEmit on the same program (mean). */
  checkVsTsc: number;
  /** gzip size of the build without the core ÷ the TS + Zod twin. */
  noCoreBundleVsTs: number;
  /** What the core adds, gzip bytes. */
  coreAddsGzipBytes: number;
  /** SeamScript send → DOM p95 ÷ the TS twin's, frame mode, per browser and rate (worst round). */
  latencyP95VsTs: number;
  /** Start-up (seam:main p50) with the core ÷ without, per browser. */
  startupCoreVsNoCore: number;
}

export function loadBudgets(): Budgets {
  return JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8")) as Budgets;
}

export interface Verdict {
  name: string;
  actual: string;
  limit: string;
  ok: boolean;
}

const r2 = (x: number) => `${x.toFixed(2)}×`;

/**
 * Measured only for reference when asked for (`--browsers firefox`): Playwright's
 * Firefox build runs WebAssembly far slower than Mozilla's builds, which no
 * change here can fix (DECISIONS.md).
 */
const referenceOnly = (browser: string) => browser.startsWith("firefox");

export function evaluate(results: Record<string, unknown>, budgets: Budgets = loadBudgets()): Verdict[] {
  const out: Verdict[] = [];
  const ratio = (name: string, actual: number, limit: number) => out.push({ name, actual: r2(actual), limit: r2(limit), ok: actual <= limit });

  const micro = results["micro"] as Record<string, MicroRun> | undefined;
  const node = micro?.["node (core)"];
  if (node) {
    const p50 = (group: string, pred: (name: string) => boolean) => node.results.find((r) => r.group === group && pred(r.name))?.p50 ?? NaN;
    for (const g of ["decode: tick", "decode: order event", "decode: snapshot (40 + 1000 orders)"]) {
      ratio(`Node ${g}: SeamScript ÷ Zod with the same checks`, p50(g, (n) => n.startsWith("SeamScript")) / p50(g, (n) => n.includes("same checks")), budgets.decodeVsZodSameChecks);
    }
    for (const sample of ["Japanese 20", "Khmer (changed in Unicode 17)"]) {
      ratio(`Node length ${sample}: Text ÷ Intl`, p50(`length: ${sample}`, (n) => n.includes("uncached")) / p50(`length: ${sample}`, (n) => n.startsWith("Intl")), budgets.textLengthVsIntl);
      ratio(`Node NFC ${sample}: Text.nfc ÷ normalize`, p50(`NFC: ${sample}`, (n) => n === "Text.nfc") / p50(`NFC: ${sample}`, (n) => n.startsWith("String")), budgets.textNfcVsNormalize);
    }
  }

  const check = results["checkTime"] as CheckTimeResult | undefined;
  if (check) {
    const seamc = check.commands["seamc check (app)"];
    const tsc = check.commands["tsc --noEmit (app, as plain TS)"];
    if (seamc && tsc) ratio("seamc check ÷ tsc (same program)", seamc.mean / tsc.mean, budgets.checkVsTsc);
  }

  const bundle = results["bundle"] as Record<string, BundleSize> | undefined;
  if (bundle) {
    const core = bundle["SeamScript (WASM core)"]!;
    const none = bundle["SeamScript (no core)"]!;
    const ts = bundle["TypeScript + Zod"]!;
    ratio("Bundle gzip: no core ÷ TS + Zod", none.gzip / ts.gzip, budgets.noCoreBundleVsTs);
    const added = core.gzip - none.gzip;
    out.push({ name: "gzip bytes added by the core", actual: `${added}`, limit: `${budgets.coreAddsGzipBytes}`, ok: added <= budgets.coreAddsGzipBytes });
  }

  const latency = results["latency"] as LatencyRun[] | undefined;
  if (latency) {
    // The app as designed (frame mode): what a user sees.
    const frame = latency.filter((r) => r.mode === "frame");
    const keys = [...new Set(frame.filter((r) => !referenceOnly(r.browser)).map((r) => `${r.browser}|${r.rate}`))];
    for (const key of keys) {
      const [browser, rate] = key.split("|");
      const runs = frame.filter((r) => `${r.browser}|${r.rate}` === key);
      const worst = (app: string) => Math.max(...runs.filter((r) => r.app === app).map((r) => r.sendToDom.p95));
      ratio(`Latency (send→DOM) p95 ${browser} ${rate} messages/s: SeamScript ÷ TS`, worst("SeamScript") / worst("TypeScript + Zod"), budgets.latencyP95VsTs);
    }
  }

  const startup = results["startup"] as StartupResult | undefined;
  if (startup) {
    for (const [browser, s] of Object.entries(startup.browsers)) if (!referenceOnly(browser)) ratio(`Start-up ${browser}: with core ÷ without`, s.core.p50 / s.noCore.p50, budgets.startupCoreVsNoCore);
  }
  return out;
}
