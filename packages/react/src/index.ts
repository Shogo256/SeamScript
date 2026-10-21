import { useEffect, useState } from "react";

/** A latest function, or anything else whose `fork()` returns something cancellable. */
export interface Forkable {
  fork(): { cancel(): void };
}

/**
 * This component's own line of a latest function: `useFork(search)` returns
 * `search.fork()`, made once per component. Its calls make only the component's
 * own earlier calls stale, so two mounted components never cancel each other's
 * requests, and unmounting cancels whatever is still in flight (those calls
 * resolve to `Stale`).
 *
 * ```tsx
 * function SearchBox() {
 *   const find = useFork(search);
 *   const [hits, setHits] = useState<Hit[]>([]);
 *   const onInput = async (q: string) => {
 *     const r = await find(q);
 *     if (r.ok) setHits(r.value); // a Stale result is simply dropped
 *   };
 *   ...
 * }
 * ```
 *
 * The same fork comes back on every render. Passing a different function makes
 * a new fork and cancels the previous one. A fork stays usable after `cancel()`,
 * so React's StrictMode double effects in development do no harm.
 */
export function useFork<F extends Forkable>(fn: F): ReturnType<F["fork"]> {
  const [state, setState] = useState(() => ({ fn, fork: fn.fork() }));
  let current = state;
  if (state.fn !== fn) {
    // Adjusting state while rendering, as React documents for derived state: the
    // render restarts right away with the new fork, before any effect runs.
    current = { fn, fork: fn.fork() };
    setState(current);
  }
  const { fork } = current;
  useEffect(() => () => fork.cancel(), [fork]);
  return fork as ReturnType<F["fork"]>;
}
