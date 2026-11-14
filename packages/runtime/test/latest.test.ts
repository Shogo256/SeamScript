import { afterEach, describe, expect, it, vi } from "vitest";
import { __b, __decode, __latest, __latestFor, type DecodeError, err, fetch, ok, type Result } from "../src/index.js";

const STALE = { ok: false, error: { kind: "stale" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A latest function whose calls settle only when the test says so. */
function controlled() {
  const pending: ReturnType<typeof deferred<Result<string, never>>>[] = [];
  const fn = __latest(async (q: string) => {
    const d = deferred<Result<string, never>>();
    pending.push(d);
    const r = await d.promise;
    return r.ok ? ok(`${q}:${r.value}`) : r;
  });
  return { fn, pending };
}

describe("generations", () => {
  it("turns an older call that settles later into Stale", async () => {
    const { fn, pending } = controlled();
    const first = fn("ab");
    const second = fn("abc");
    pending[1]!.resolve(ok("2"));
    pending[0]!.resolve(ok("1"));
    expect(await second).toEqual({ ok: true, value: "abc:2" });
    expect(await first).toEqual(STALE);
  });

  it("also turns an older call that settles first into Stale once a newer call exists", async () => {
    const { fn, pending } = controlled();
    const first = fn("ab");
    const second = fn("abc");
    pending[0]!.resolve(ok("1"));
    expect(await first).toEqual(STALE);
    pending[1]!.resolve(ok("2"));
    expect(await second).toEqual({ ok: true, value: "abc:2" });
  });

  it("delivers a call that settled before the next one started", async () => {
    const { fn, pending } = controlled();
    const first = fn("a");
    pending[0]!.resolve(ok("1"));
    expect(await first).toEqual({ ok: true, value: "a:1" });
    const second = fn("ab");
    pending[1]!.resolve(ok("2"));
    expect(await second).toEqual({ ok: true, value: "ab:2" });
  });

  it("turns rejections of superseded calls into Stale and propagates the latest one's", async () => {
    const { fn, pending } = controlled();
    const first = fn("a");
    const second = fn("b");
    pending[0]!.reject(new Error("old"));
    pending[1]!.reject(new Error("new"));
    expect(await first).toEqual(STALE);
    await expect(second).rejects.toThrow("new");
  });

  it("turns a synchronous throw into a rejection", async () => {
    const fn = __latest((): Promise<Result<1, never>> => {
      throw new Error("sync");
    });
    await expect(fn()).rejects.toThrow("sync");
  });
});

describe("AbortSignal", () => {
  it("supplies the signal at its parameter position and aborts superseded calls", async () => {
    const signals: AbortSignal[] = [];
    const fn = __latest(
      async (q: string, signal: AbortSignal) => {
        signals.push(signal);
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        return ok(q);
      },
      { signal: 1 },
    );
    const first = fn("a");
    expect(signals[0]!.aborted).toBe(false);
    void fn("b");
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    // The AbortError of the superseded call is absorbed.
    expect(await first).toEqual(STALE);
  });

  it("keeps the signal in place when optional arguments before it are omitted", async () => {
    const seen: unknown[][] = [];
    const impl = async (q?: string, signal?: AbortSignal) => {
      seen.push([q, signal instanceof AbortSignal]);
      return ok(q ?? "");
    };
    const fn = __latest(impl as (q: string | undefined, signal: AbortSignal) => Promise<Result<string, never>>, {
      signal: 1,
    });
    await (fn as unknown as () => Promise<unknown>)();
    await fn("x");
    expect(seen).toEqual([
      [undefined, true],
      ["x", true],
    ]);
  });
});

describe("fork and cancel", () => {
  it("gives each fork its own generation line", async () => {
    const { fn, pending } = controlled();
    const a = fn.fork();
    const b = fn.fork();
    const ra = a("a");
    const rb = b("b");
    const rRoot = fn("root");
    pending[0]!.resolve(ok("1"));
    pending[1]!.resolve(ok("2"));
    pending[2]!.resolve(ok("3"));
    expect(await Promise.all([ra, rb, rRoot])).toEqual([
      { ok: true, value: "a:1" },
      { ok: true, value: "b:2" },
      { ok: true, value: "root:3" },
    ]);
  });

  it("makes in-flight calls Stale, including the newest one, and stays usable", async () => {
    const { fn, pending } = controlled();
    const line = fn.fork();
    const inFlight = line("a");
    line.cancel();
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    expect(await inFlight).toEqual(STALE);
    const next = line("b");
    pending[1]!.resolve(ok("2"));
    expect(await next).toEqual({ ok: true, value: "b:2" });
  });

  it("aborts the in-flight signal on cancel", async () => {
    let seen: AbortSignal | undefined;
    const fn = __latest(
      async (signal: AbortSignal) => {
        seen = signal;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        return ok(0);
      },
      { signal: 0 },
    );
    const line = fn.fork();
    const call = line();
    line.cancel();
    expect(seen!.aborted).toBe(true);
    expect(await call).toEqual(STALE);
  });
});

// Milestone demo, bug 3: typing "ab" then "abc" while the "ab" response arrives last.
describe("search race (spec milestone demo)", () => {
  type SearchResult = { query: string; hits: number };
  const SearchResult = __b.object<SearchResult>({ query: __b.string, hits: __b.number });

  // Responses are released in a fixed order, so the race reproduces every run.
  function mockFetch() {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    vi.stubGlobal("fetch", async (input: string) => {
      const q = new URL(input, "http://test").searchParams.get("q")!;
      const gate = deferred<void>();
      gates.set(q, gate);
      await gate.promise;
      return new Response(JSON.stringify({ query: q, hits: q.length }));
    });
    return (q: string) => gates.get(q)!.resolve();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it("plain async code shows the stale result", async () => {
    const release = mockFetch();
    let screen: string | undefined;
    async function search(q: string): Promise<Result<SearchResult, DecodeError>> {
      const res = await fetch(`/api/search?q=${q}`);
      return __decode(SearchResult, await res.json());
    }
    const onInput = async (q: string) => {
      const r = await search(q);
      if (r.ok) screen = r.value.query;
    };
    const typing = [onInput("ab"), onInput("abc")];
    await settle();
    release("abc");
    await settle();
    release("ab");
    await Promise.all(typing);
    expect(screen).toBe("ab"); // the bug
  });

  it("latest keeps the newest result on screen", async () => {
    const release = mockFetch();
    let screen: string | undefined;
    const search = __latest(async (q: string) => {
      const res = await fetch(`/api/search?q=${q}`);
      return __decode(SearchResult, await res.json());
    });
    const onInput = async (q: string) => {
      const r = await search(q);
      if (r.ok) screen = r.value.query;
    };
    const typing = [onInput("ab"), onInput("abc")];
    await settle();
    release("abc");
    await settle();
    release("ab");
    await Promise.all(typing);
    expect(screen).toBe("abc");
  });
});

describe("__latestFor (compiled latest declarations)", () => {
  it("creates one wrapper per implementation, on first use", async () => {
    async function impl(q: string) {
      return ok(q);
    }
    const a = __latestFor(impl);
    expect(__latestFor(impl)).toBe(a);
    expect(await a("x")).toEqual({ ok: true, value: "x" });
    expect(typeof a.fork().cancel).toBe("function");
  });
});

describe("errors from the function's own Result", () => {
  it("passes Err values through like Ok values", async () => {
    const fn = __latest(async (n: number) => (n > 0 ? ok(n) : err({ kind: "negative" as const })));
    expect(await fn(-1)).toEqual({ ok: false, error: { kind: "negative" } });
  });
});

describe("within (deadlines)", () => {
  afterEach(() => vi.useRealTimers());

  /** A latest function with a signal that settles only when the test says so, or rejects on abort. */
  function slow() {
    const pending: ReturnType<typeof deferred<Result<string, never>>>[] = [];
    const signals: AbortSignal[] = [];
    const fn = __latest(
      async (q: string, signal: AbortSignal) => {
        const d = deferred<Result<string, never>>();
        pending.push(d);
        signals.push(signal);
        signal.addEventListener("abort", () => d.reject(signal.reason));
        const r = await d.promise;
        return r.ok ? ok(`${q}:${r.value}`) : r;
      },
      { signal: 1 },
    );
    return { fn, pending, signals };
  }

  it("delivers a call that settles before its deadline", async () => {
    vi.useFakeTimers();
    const { fn, pending } = slow();
    const call = fn.within(2000)("a");
    pending[0]!.resolve(ok("1"));
    expect(await call).toEqual({ ok: true, value: "a:1" });
  });

  it("aborts a call that misses its deadline and resolves it to Timeout, without an unhandled AbortError", async () => {
    vi.useFakeTimers();
    const { fn, signals } = slow();
    const call = fn.within(2000)("a");
    await vi.advanceTimersByTimeAsync(1999);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toEqual({ ok: false, error: { kind: "timeout", ms: 2000 } });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("ignores a result that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const fn = __latest(async (q: string) => {
      await new Promise((r) => setTimeout(r, 3000));
      return ok(q);
    });
    const call = fn.within(1000)("late");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await call).toEqual({ ok: false, error: { kind: "timeout", ms: 1000 } });
  });

  it("makes a call Stale, not Timeout, when a newer call started before its deadline", async () => {
    vi.useFakeTimers();
    const { fn, pending, signals } = slow();
    const first = fn.within(2000)("a");
    const second = fn.within(2000)("ab");
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toEqual(STALE);
    expect(await second).toEqual({ ok: false, error: { kind: "timeout", ms: 2000 } });
    expect(pending).toHaveLength(2);
  });

  it("does not abort a newer plain call when an older call's deadline passes", async () => {
    vi.useFakeTimers();
    const { fn, pending, signals } = slow();
    const first = fn.within(1000)("a");
    const second = fn("ab");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toEqual(STALE);
    expect(signals[1]!.aborted).toBe(false);
    pending[1]!.resolve(ok("2"));
    expect(await second).toEqual({ ok: true, value: "ab:2" });
  });

  it("shares a fork's line, and a fork's cancel makes a pending deadline call Stale", async () => {
    vi.useFakeTimers();
    const { fn, signals } = slow();
    const line = fn.fork();
    const call = line.within(5000)("a");
    line.cancel();
    expect(signals[0]!.aborted).toBe(true);
    expect(await call).toEqual(STALE);
  });

  it("propagates the latest call's own rejection before its deadline", async () => {
    vi.useFakeTimers();
    const fn = __latest(async () => {
      throw new Error("boom");
    });
    await expect(fn.within(1000)()).rejects.toThrow("boom");
  });

  it("refuses a deadline that is not a finite number of milliseconds", () => {
    const fn = __latest(async () => ok(1));
    expect(() => fn.within(Number.NaN)()).toThrow(RangeError);
    expect(() => fn.within(-1)()).toThrow(RangeError);
  });
});
