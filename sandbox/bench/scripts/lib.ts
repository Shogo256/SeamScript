import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, firefox, webkit } from "@playwright/test";

export { Backend, startBackend } from "../../e2e/support/backend.ts";

/** sandbox/ */
export const sandbox = fileURLToPath(new URL("../../", import.meta.url));
/** sandbox/bench/ */
export const benchDir = fileURLToPath(new URL("../", import.meta.url));

export const BROWSERS = { chromium, firefox, webkit } as const;
export type BrowserName = keyof typeof BROWSERS;

export async function withBrowser<T>(name: BrowserName, f: (b: Browser) => Promise<T>): Promise<T> {
  const b = await BROWSERS[name].launch();
  try {
    return await f(b);
  } finally {
    await b.close();
  }
}

/** Runs a command and returns its stdout; throws on failure. */
export function run(cmd: string, args: string[], cwd = sandbox): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

export function summary(xs: readonly number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    mean: s.length === 0 ? NaN : s.reduce((a, b) => a + b, 0) / s.length,
    min: s[0] ?? NaN,
    max: s[s.length - 1] ?? NaN,
  };
}

export function shuffled<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function log(...args: unknown[]): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
