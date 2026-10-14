// A small benchmark harness that runs the same way in Node and in browsers.
//
// - Each case is calibrated so one batch takes at least `batchMs` (10 ms). Pages
//   are cross-origin isolated, so browsers time to tens of microseconds or better.
// - Warm-up runs every case before anything is recorded (JIT tiers settle).
// - Samples are taken in rounds, and the order of cases is shuffled each round,
//   so slow drift (thermal, GC pressure) spreads over all cases instead of
//   biasing whichever ran last.
// - Reported per operation: p50 / p95 / p99 over the batch samples.

export interface Case {
  readonly group: string;
  readonly name: string;
  readonly fn: () => unknown;
}

export interface Stats {
  readonly group: string;
  readonly name: string;
  /** Nanoseconds per operation. */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly samples: number;
  readonly batch: number;
}

export interface Options {
  batchMs?: number;
  warmupMs?: number;
  rounds?: number;
  samplesPerRound?: number;
  /** Called between cases; a browser uses it to yield to the event loop. */
  pause?: () => Promise<void>;
  /** Told which case is about to run, so a hang can be traced to one case. */
  progress?: (label: string) => void;
}

let sink: unknown;
/** Keeps results alive so the engine cannot drop the work. */
export function consume(): unknown {
  return sink;
}

function batchSize(fn: () => unknown, batchMs: number): number {
  let n = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) sink = fn();
    const ms = performance.now() - t0;
    if (ms >= batchMs) return n;
    // Extrapolate only from a duration well above the clock's resolution. Firefox
    // adds jitter to performance.now(): a few microseconds measured as almost
    // nothing once made n hundreds of times too large (seconds per sample).
    n = ms < 1 ? n * 10 : Math.max(n + 1, Math.min(n * 10, Math.ceil((n * batchMs * 1.2) / ms)));
  }
}

function timeBatch(fn: () => unknown, n: number): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) sink = fn();
  return ((performance.now() - t0) * 1e6) / n;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(xs: readonly number[]): { p50: number; p95: number; p99: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

function shuffled<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function bench(cases: readonly Case[], options: Options = {}): Promise<Stats[]> {
  const { batchMs = 10, warmupMs = 200, rounds = 5, samplesPerRound = 20, pause = async () => {}, progress = () => {} } = options;
  const sizes = new Map<Case, number>();
  for (const c of cases) {
    progress(`calibrate ${c.group} / ${c.name}`);
    await pause();
    const n = batchSize(c.fn, batchMs);
    const until = performance.now() + warmupMs;
    while (performance.now() < until) timeBatch(c.fn, n);
    sizes.set(c, n);
    await pause();
  }
  const samples = new Map<Case, number[]>(cases.map((c) => [c, []]));
  for (let r = 0; r < rounds; r++) {
    for (const c of shuffled(cases)) {
      progress(`round ${r + 1} ${c.group} / ${c.name}`);
      const n = sizes.get(c)!;
      const out = samples.get(c)!;
      for (let k = 0; k < samplesPerRound; k++) out.push(timeBatch(c.fn, n));
      await pause();
    }
  }
  return cases.map((c) => ({ group: c.group, name: c.name, ...summarize(samples.get(c)!), samples: samples.get(c)!.length, batch: sizes.get(c)! }));
}
