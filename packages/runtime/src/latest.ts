import { type Result, type Stale, STALE, type Timeout, timeout } from "./result.js";

export type LatestCall<A extends unknown[], R> = (...args: A) => Promise<R | Stale>;

export type Latest<A extends unknown[], R> = LatestCall<A, R> & {
  /** A copy with its own generation line: its calls never make other lines' calls stale. */
  fork(): LatestFork<A, R>;
  /**
   * The same line with a deadline: a call that has not settled `ms` milliseconds after it
   * started aborts its `AbortSignal` and resolves to `Timeout` (or `Stale`, if a newer call
   * started meanwhile). Calls through `within` and plain calls share one generation line.
   */
  within(ms: number): LatestCall<A, R | Timeout>;
};

export type LatestFork<A extends unknown[], R> = Latest<A, R> & {
  /** Aborts and invalidates this line's in-flight calls (they resolve to `Stale`). The fork stays usable. */
  cancel(): void;
};

export interface LatestOptions {
  /**
   * Position of the `AbortSignal` parameter, which the wrapper supplies and callers
   * never pass. A position rather than "last argument" so that omitted optional
   * arguments before it do not shift the signal into their place.
   */
  readonly signal: number;
}

// `any[]` only in the implementation signature; callers see the typed overloads.
type AnyFn = (...args: any[]) => Promise<Result<unknown, unknown>>;

/**
 * Compiled form of `latest async function`. Each call gets a generation number;
 * when it settles, it delivers its own outcome only if no newer call has started
 * and the line was not cancelled since. Otherwise it resolves to `Stale`, whether
 * it fulfilled or rejected, so superseded calls never surface an AbortError or an
 * unhandled rejection.
 */
export function __latest<A extends unknown[], R extends Result<unknown, unknown>>(
  fn: (...args: A) => Promise<R>,
): Latest<A, R>;
export function __latest<A extends unknown[], R extends Result<unknown, unknown>>(
  fn: (...args: [...A, AbortSignal]) => Promise<R>,
  options: LatestOptions,
): Latest<A, R>;
export function __latest(fn: AnyFn, options?: LatestOptions): Latest<any[], Result<unknown, unknown>> {
  const root = line(fn, options?.signal);
  return Object.assign(root.call, { fork: root.fork, within: root.within });
}

const declared = new WeakMap<AnyFn, Latest<any[], Result<unknown, unknown>>>();

/**
 * Compiled form of a `latest async function` declaration. The emitted function
 * declaration stays hoisted like the original, so its wrapper cannot live in a
 * module-level const; it is created on first call and cached per implementation.
 */
export function __latestFor<A extends unknown[], R extends Result<unknown, unknown>>(
  fn: (...args: A) => Promise<R>,
): Latest<A, R>;
export function __latestFor<A extends unknown[], R extends Result<unknown, unknown>>(
  fn: (...args: [...A, AbortSignal]) => Promise<R>,
  options: LatestOptions,
): Latest<A, R>;
export function __latestFor(fn: AnyFn, options?: LatestOptions): Latest<any[], Result<unknown, unknown>> {
  let l = declared.get(fn);
  if (l === undefined) {
    const root = line(fn, options?.signal);
    l = Object.assign(root.call, { fork: root.fork, within: root.within });
    declared.set(fn, l);
  }
  return l;
}

/** Parameters of a compiled latest function: the implementation's, minus a trailing AbortSignal. */
export type LatestArgs<F extends (...args: any[]) => unknown, HasSignal extends boolean> = HasSignal extends true
  ? Parameters<F> extends [...infer A, unknown]
    ? A
    : never
  : Parameters<F>;

export type LatestReturn<F extends (...args: any[]) => unknown> = Promise<Awaited<ReturnType<F>> | Stale>;

function line(fn: AnyFn, signalIndex: number | undefined) {
  let generation = 0;
  let controller: AbortController | undefined;

  const call = (...args: unknown[]): Promise<Result<unknown, unknown> | Stale> => {
    const gen = ++generation;
    controller?.abort();
    controller = undefined;
    let callArgs = args;
    if (signalIndex !== undefined) {
      const c = (controller = new AbortController());
      callArgs = args.slice(0, signalIndex);
      callArgs.length = signalIndex;
      callArgs.push(c.signal);
    }
    // The executor runs synchronously, so a synchronous throw from `fn` becomes a rejection.
    return new Promise<Result<unknown, unknown>>((resolve) => resolve(fn(...callArgs))).then(
      (value) => (gen === generation ? value : STALE),
      (error: unknown) => {
        if (gen === generation) throw error;
        return STALE;
      },
    );
  };

  const cancel = (): void => {
    generation++;
    controller?.abort();
    controller = undefined;
  };

  const within =
    (ms: number) =>
    (...args: unknown[]): Promise<Result<unknown, unknown> | Stale | Timeout> => {
      if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError(`within: the deadline must be a finite number of milliseconds >= 0, not ${ms}`);
      const settled = call(...args);
      const gen = generation;
      const mine = controller;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (gen !== generation) return resolve(STALE);
          // Only this call's signal: a newer call has its own controller.
          if (controller === mine) {
            mine?.abort();
            controller = undefined;
          }
          resolve(timeout(ms));
        }, ms);
        // Once the timer has resolved this promise, the later settlement is ignored, including
        // the AbortError the abort above causes, so nothing goes unhandled.
        settled.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    };

  const fork = (): LatestFork<unknown[], Result<unknown, unknown>> => {
    const l = line(fn, signalIndex);
    return Object.assign(l.call, { fork: l.fork, cancel: l.cancel, within: l.within });
  };

  return { call, cancel, fork, within };
}
