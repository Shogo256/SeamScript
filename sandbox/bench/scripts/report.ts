// results.json → report.md (tables in English, numbers as measured).
import type { BundleSize } from "./bundle.ts";
import type { CheckTimeResult } from "./checktime.ts";
import type { LatencyRun } from "./latency.ts";
import type { Summary } from "./lib.ts";
import type { MicroRun } from "./micro.ts";
import type { StartupResult } from "./startup.ts";
import { evaluate } from "./budgets.ts";

/** Nanoseconds, in the unit that keeps three significant digits. */
export function ns(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x < 1000) return `${x.toFixed(0)} ns`;
  if (x < 1e6) return `${(x / 1000).toPrecision(3)} µs`;
  return `${(x / 1e6).toPrecision(3)} ms`;
}

const ms = (x: number) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(2) : x.toFixed(1)} ms` : "—");
const kb = (x: number) => `${(x / 1024).toFixed(1)} KB`;
const three = (s: { p50: number; p95: number; p99: number }, f: (x: number) => string) => `${f(s.p50)} / ${f(s.p95)} / ${f(s.p99)}`;

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function decodeSection(micro: Record<string, MicroRun>): string {
  const out = [
    "## decode (per call, p50 / p95 / p99)",
    "",
    "\"Zod with the same checks\" is a schema that does the same work as SeamScript, down to bigint conversion, Decimal normalization and Text NFC normalization (`src/zod-equivalent.ts`). \"The TS app's Zod\" is the schemas of the comparison app `app-ts`: IDs and prices stay strings, with no normalization. Ratios compare p50 with p50.",
    "",
  ];
  for (const [env, run] of Object.entries(micro)) {
    const groups = [...new Set(run.results.filter((r) => r.group.includes("decode")).map((r) => r.group))];
    if (groups.length === 0) continue;
    out.push(`### ${run.env}${run.isolated === false ? " (coarse timer resolution)" : ""}`, "");
    const rows: string[][] = [];
    for (const g of groups) {
      const rs = run.results.filter((r) => r.group === g);
      const ref = rs.find((r) => r.name.includes("same checks")) ?? rs.find((r) => r.name === "JSON.parse only");
      for (const r of rs) rows.push([g, r.name, three(r, ns), ref && ref !== r ? `${(r.p50 / ref.p50).toFixed(2)}×` : ""]);
    }
    out.push(table(["Input", "Method", "p50 / p95 / p99", "Ratio"], rows), "");
    void env;
  }
  return out.join("\n");
}

function textSection(micro: Record<string, MicroRun>): string {
  const out = [
    "## Text operations (per call, p50 / p95 / p99)",
    "",
    "\"1024 strings\" cycles through 1024 different strings so that Text's grapheme-boundary cache (256 entries) never hits. The baselines are the browser's (or Node's) own `Intl.Segmenter` and `String.prototype.normalize`.",
    "",
  ];
  for (const run of Object.values(micro)) {
    const rs = run.results.filter((r) => !r.group.includes("decode"));
    if (rs.length === 0) continue;
    out.push(`### ${run.env} (Text: ${run.text.deterministic ? `WASM core, Unicode ${run.text.unicode}` : "host ICU"})`, "");
    out.push(table(["Operation / string", "Method", "p50 / p95 / p99"], rs.map((r) => [r.group, r.name, three(r, ns)])), "");
  }
  return out.join("\n");
}

function startupSection(s: StartupResult): string {
  const rows = Object.entries(s.browsers).map(([env, r]) => [
    env,
    three(r.noCore, ms),
    three(r.core, ms),
    ms(r.core.p50 - r.noCore.p50),
    three(r.instantiate, ms),
  ]);
  return [
    "## Start-up time added by loading the WASM core",
    "",
    "The same app is built with and without the core, and the two builds are loaded alternately in fresh contexts. Values run from navigation start to the start of the main module (`seam:main`). With the core, main runs only after the core's top-level await (base64 decoding, compilation, instantiation) settles.",
    "",
    table(["Browser", "Without core p50 / p95 / p99", "With core p50 / p95 / p99", "Difference (p50)", "WebAssembly.instantiate p50 / p95 / p99"], rows),
    "",
    `Node (import in a fresh process): \`@seamscript/core\` ${three(s.node.core, ms)}; \`@seamscript/runtime\` alone ${three(s.node.runtimeOnly, ms)} (${s.node.core.n} runs each).`,
    "",
  ].join("\n");
}

function latencySection(runs: LatencyRun[]): string {
  const out = [
    "## Latency from server send to DOM update",
    "",
    "For every price tick, the page records when the WebSocket received it and when that row's data-version changed (MutationObserver). Receive→DOM is measured entirely inside the page. Send→DOM is measured from the server's send time and includes the network, waiting in the page's event queue, and clock skew between processes. \"Handler\" is the time the app itself measures to decode and apply one message (rendering not included). Each condition is repeated with the order of the apps swapped.",
    "",
    "- **Per frame** (the app as designed): state updates on every message, and the UI is notified once per frame. When the same instrument moves several times within one frame, the intermediate values are never shown, so \"shown/received\" drops below 1.",
    "- **Per message** (`?render=each`, for benchmarking only): the app renders on every message. With no wait for rendering, differences in handling show up more clearly, but at high rates the main thread saturates.",
    "",
  ];
  for (const mode of ["frame", "each"] as const) {
    for (const rate of [...new Set(runs.filter((r) => r.mode === mode).map((r) => r.rate))]) {
      out.push(`### ${mode === "frame" ? "Per frame" : "Per message"}, ${rate} messages/s`, "");
      const rows = runs
        .filter((r) => r.mode === mode && r.rate === rate)
        .map((r) => [r.browser, r.app, `${r.shown}/${r.received}`, three(r.receiveToDom, ms), three(r.sendToDom, ms), `${ms(r.handler.p50)} / ${ms(r.handler.p99)}`]);
      out.push(table(["Browser", "App", "Shown/received", "Receive→DOM p50 / p95 / p99", "Send→DOM p50 / p95 / p99", "Handler p50 / p99"], rows), "");
    }
  }
  return out.join("\n");
}

function checkSection(c: CheckTimeResult): string {
  const tsc = c.commands["tsc --noEmit (app, as plain TS)"];
  const rows = Object.entries(c.commands).map(([name, r]) => [name, `${r.mean.toFixed(3)} s ± ${r.stddev.toFixed(3)}`, `${r.median.toFixed(3)} s`, `${r.min.toFixed(3)}–${r.max.toFixed(3)} s`, tsc ? `${(r.mean / tsc.mean).toFixed(2)}×` : "", String(r.runs)]);
  return [
    "## `seamc check` and `tsc` times (hyperfine)",
    "",
    "To compare the same program, the baseline is `tsc --noEmit` run on the plain TS that `seamc build` emits.",
    "",
    table(["Command", "Mean ± std dev", "Median", "Min–max", "Ratio", "Runs"], rows),
    "",
  ].join("\n");
}

function bundleSection(b: Record<string, BundleSize>): string {
  const ts = b["TypeScript + Zod"];
  const rows = Object.entries(b).map(([name, s]) => [name, kb(s.raw), kb(s.gzip), kb(s.brotli), ts ? `${s.gzip - ts.gzip >= 0 ? "+" : ""}${kb(s.gzip - ts.gzip)}` : ""]);
  return ["## Bundle size (the JS and CSS that index.html loads)", "", table(["Build", "Raw", "gzip", "brotli", "Difference from TS + Zod (gzip)"], rows), ""].join("\n");
}

export function report(results: Record<string, unknown>): string {
  const meta = results["meta"] as Record<string, unknown> | undefined;
  const parts = [
    "# Benchmark results",
    "",
    meta ? `${String(meta["date"])}, ${String(meta["cpu"])} (${String(meta["cores"])} cores, ${String(meta["memoryGiB"])} GiB), Node ${String(meta["node"])}${meta["icu"] ? ` (ICU ${String(meta["icu"])}, Unicode ${String(meta["unicode"])})` : ""}, commit ${String(meta["commit"])}${meta["dirty"] ? " (with uncommitted changes)" : ""}${meta["quick"] ? ", --quick" : ""}.` : "",
    ...(typeof meta?.["loadAtStart"] === "number"
      ? ["", `Load average (1 min) at the start and end of the run: ${(meta["loadAtStart"] as number).toFixed(1)}, ${typeof meta["loadAtEnd"] === "number" ? (meta["loadAtEnd"] as number).toFixed(1) : "—"}. Absolute values move a lot when other programs are using the CPU; ratios are much less affected.`]
      : []),
    "",
  ];
  const budget = evaluate(results);
  if (budget.length > 0) {
    parts.push("## Budgets (ratios to a baseline measured in the same run)", "", table(["Item", "Measured", "Limit", "Result"], budget.map((b) => [b.name, b.actual, b.limit, b.ok ? "OK" : "Over"])), "");
  }
  if (results["micro"]) parts.push(decodeSection(results["micro"] as Record<string, MicroRun>), textSection(results["micro"] as Record<string, MicroRun>));
  if (results["startup"]) parts.push(startupSection(results["startup"] as StartupResult));
  if (results["latency"]) parts.push(latencySection(results["latency"] as LatencyRun[]));
  if (results["checkTime"]) parts.push(checkSection(results["checkTime"] as CheckTimeResult));
  if (results["bundle"]) parts.push(bundleSection(results["bundle"] as Record<string, BundleSize>));
  return parts.join("\n");
}

export type { Summary };
