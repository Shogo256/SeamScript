import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok, poll, type Result } from "../src/index.js";

type R = Result<number, string>;

/** A read whose calls the test settles one by one. */
function reads() {
  const pending: { resolve: (r: R) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = [];
  const read = (signal: AbortSignal) =>
    new Promise<R>((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    });
  return { read, pending };
}

/** A stand-in for `document` with a visibility the test can flip. */
function fakeDocument() {
  const target = new EventTarget();
  const doc = Object.assign(target, { visibilityState: "visible" as DocumentVisibilityState });
  vi.stubGlobal("document", doc);
  return (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    target.dispatchEvent(new Event("visibilitychange"));
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("poll", () => {
  it("reads at once, then every ms after each read ends, one read at a time", async () => {
    vi.useFakeTimers();
    const { read, pending } = reads();
    const seen: R[] = [];
    const p = poll(read, { every: 1000, onResult: (r) => seen.push(r) });
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pending).toHaveLength(1); // the first read is still in flight
    pending[0]!.resolve(ok(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(2);
    expect(seen).toEqual([ok(1)]);
    p.stop();
  });

  it("doubles the wait after failures up to maxEvery, and goes back to every after a success", async () => {
    vi.useFakeTimers();
    const { read, pending } = reads();
    const seen: R[] = [];
    const p = poll(read, { every: 100, maxEvery: 300, onResult: (r) => seen.push(r) });
    const gaps: number[] = [];
    let last = Date.now();
    const settleNext = async (r: R | "throw") => {
      const current = pending[pending.length - 1]!;
      if (r === "throw") current.reject(new Error("network"));
      else current.resolve(r);
      const before = pending.length;
      while (pending.length === before) await vi.advanceTimersByTimeAsync(10);
      gaps.push(Date.now() - last);
      last = Date.now();
    };
    await settleNext(err("a")); // 200
    await settleNext("throw"); // 300 (capped)
    await settleNext(err("b")); // 300
    await settleNext(ok(1)); // 100
    expect(gaps).toEqual([200, 300, 300, 100]);
    // A throw has no Result to deliver.
    expect(seen).toEqual([err("a"), err("b"), ok(1)]);
    p.stop();
  });

  it("starts no read while the page is hidden, and reads at once when it is shown if one fell due", async () => {
    vi.useFakeTimers();
    const show = fakeDocument();
    const { read, pending } = reads();
    const p = poll(read, { every: 1000, onResult: () => {} });
    pending[0]!.resolve(ok(1));
    await vi.advanceTimersByTimeAsync(0);
    show("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending).toHaveLength(1);
    show("visible");
    expect(pending).toHaveLength(2);
    p.stop();
  });

  it("does not read on being shown when no read fell due", async () => {
    vi.useFakeTimers();
    const show = fakeDocument();
    const { read, pending } = reads();
    const p = poll(read, { every: 1000, onResult: () => {} });
    pending[0]!.resolve(ok(1));
    await vi.advanceTimersByTimeAsync(0);
    show("hidden");
    show("visible");
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(2);
    p.stop();
  });

  it("now() reads at once, or right after a read in flight", async () => {
    vi.useFakeTimers();
    const { read, pending } = reads();
    const p = poll(read, { every: 60_000, onResult: () => {} });
    p.now(); // a read is in flight: queue one more
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(ok(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(ok(2));
    await vi.advanceTimersByTimeAsync(0);
    p.now(); // idle: read at once instead of in a minute
    expect(pending).toHaveLength(3);
    p.stop();
  });

  it("stop() aborts the read in flight, drops its result and reads no more", async () => {
    vi.useFakeTimers();
    const { read, pending } = reads();
    const seen: R[] = [];
    const p = poll(read, { every: 100, onResult: (r) => seen.push(r) });
    p.stop();
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve(ok(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([]);
    expect(pending).toHaveLength(1);
    p.now();
    expect(pending).toHaveLength(1);
  });

  it("refuses intervals that are not positive finite milliseconds", () => {
    const { read } = reads();
    expect(() => poll(read, { every: 0, onResult: () => {} })).toThrow(RangeError);
    expect(() => poll(read, { every: 100, maxEvery: 50, onResult: () => {} })).toThrow(RangeError);
  });
});
