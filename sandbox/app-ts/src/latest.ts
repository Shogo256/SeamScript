// What a TypeScript codebase writes by hand in place of `latest async function`:
// a generation counter plus an AbortController per line of calls.

export type Stale = { ok: false; error: { kind: "stale" } };
const STALE: Stale = { ok: false, error: { kind: "stale" } };

export interface LatestLine<A extends unknown[], R> {
  (...args: A): Promise<R | Stale>;
  cancel(): void;
}

export function latestLine<A extends unknown[], R>(fn: (signal: AbortSignal, ...args: A) => Promise<R>): LatestLine<A, R> {
  let generation = 0;
  let controller: AbortController | undefined;
  const call = async (...args: A): Promise<R | Stale> => {
    const gen = ++generation;
    controller?.abort();
    const c = (controller = new AbortController());
    try {
      const value = await fn(c.signal, ...args);
      return gen === generation ? value : STALE;
    } catch (e) {
      if (gen === generation) throw e;
      return STALE;
    }
  };
  return Object.assign(call, {
    cancel() {
      generation++;
      controller?.abort();
    },
  });
}
