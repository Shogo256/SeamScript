import type { Result } from "./result.js";

export interface PollOptions<R> {
  /** Milliseconds from the end of one read to the start of the next, while reads succeed. */
  readonly every: number;
  /**
   * After a failed read (an `Err`, or a throw) the wait doubles, up to this many milliseconds;
   * the next success brings it back to `every`. Defaults to `every * 8`.
   */
  readonly maxEvery?: number;
  /** Each read's `Result`, in order. Never called after `stop()`. */
  readonly onResult: (result: R) => void;
}

export interface Poller {
  /** Reads now instead of at the next tick; if a read is in flight, reads again right after it. */
  now(): void;
  /** Stops for good: aborts a read in flight (its result is dropped) and clears the timer. */
  stop(): void;
}

/**
 * Reads `read` again and again: one read at a time, `every` ms apart, backing off after
 * failures. While the page is hidden (`document.visibilityState`) no read starts; when it is
 * shown again, a read that fell due meanwhile starts at once. The first read starts at once.
 *
 * A read that throws counts as a failure for the backoff but has no `Result` to deliver;
 * return an `Err` for failures the caller should see.
 */
export function poll<R extends Result<unknown, unknown>>(read: (signal: AbortSignal) => Promise<R>, options: PollOptions<R>): Poller {
  const every = options.every;
  const maxEvery = options.maxEvery ?? every * 8;
  if (!(Number.isFinite(every) && every > 0)) throw new RangeError(`poll: every must be a finite number of milliseconds > 0, not ${every}`);
  if (!(Number.isFinite(maxEvery) && maxEvery >= every)) throw new RangeError(`poll: maxEvery must be a finite number >= every, not ${maxEvery}`);

  const page = typeof document === "undefined" ? undefined : document;
  let wait = every;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let due = false;
  let again = false;
  let stopped = false;

  const hidden = () => page?.visibilityState === "hidden";

  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, ms);
  };

  const tick = () => {
    if (stopped) return;
    if (hidden()) {
      due = true;
      return;
    }
    due = false;
    const c = (controller = new AbortController());
    const settle = (result: R | undefined) => {
      if (stopped || c !== controller) return;
      controller = undefined;
      const failed = result === undefined || !result.ok;
      wait = failed ? Math.min(maxEvery, wait * 2) : every;
      if (result !== undefined) options.onResult(result);
      if (stopped) return;
      if (again) {
        again = false;
        tick();
      } else {
        schedule(wait);
      }
    };
    new Promise<R>((resolve) => resolve(read(c.signal))).then(settle, () => settle(undefined));
  };

  const onVisibility = () => {
    if (!hidden() && due && controller === undefined) tick();
  };
  page?.addEventListener("visibilitychange", onVisibility);

  tick();

  return {
    now() {
      if (stopped) return;
      if (controller !== undefined) {
        again = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      tick();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
      page?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
