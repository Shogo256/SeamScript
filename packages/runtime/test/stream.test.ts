import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __b, __unknown, ChunkStream, type ObjectDecoder, type StreamEvent, type StreamPolicy } from "../src/index.js";

type Chunk = { seq: number; text: string };
const Chunk: ObjectDecoder<Chunk> = __b.object<Chunk>({ seq: __b.number, text: __b.string });

/** A stream over Chunk whose events are collected; `send(3)` pushes chunk 3. */
function setup(policy: Partial<StreamPolicy<Chunk>> = {}) {
  const events: StreamEvent<Chunk>[] = [];
  const stream = ChunkStream.of(Chunk, { seq: (c) => c.seq, ...policy }, (e) => events.push(e));
  const send = (...seqs: number[]) => {
    for (const seq of seqs) stream.push(__unknown({ seq, text: `t${seq}` }));
  };
  const delivered = () => events.flatMap((e) => (e.kind === "chunk" ? [e.seq] : []));
  const others = () => events.filter((e) => e.kind !== "chunk");
  return { stream, send, events, delivered, others };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ChunkStream", () => {
  it("delivers chunks in order, starting from the first that arrives", () => {
    const s = setup();
    s.send(5, 6, 7);
    expect(s.delivered()).toEqual([5, 6, 7]);
    expect(s.events[0]).toEqual({ kind: "chunk", seq: 5, value: { seq: 5, text: "t5" } });
  });

  it("by default skips a gap at once and drops what comes late, counting both", () => {
    const s = setup({ first: 0 });
    s.send(0, 2, 1, 3);
    expect(s.delivered()).toEqual([0, 2, 3]);
    expect(s.others()).toEqual([]);
    expect(s.stream.stats).toMatchObject({ delivered: 3, gaps: 1, late: 1, duplicates: 0 });
  });

  it("holds later chunks while a gap may fill, and delivers them in order when it does", () => {
    const s = setup({ first: 0, gap: { wait: 100, then: "error" } });
    s.send(0, 3, 2);
    expect(s.delivered()).toEqual([0]);
    vi.advanceTimersByTime(50);
    s.send(1);
    expect(s.delivered()).toEqual([0, 1, 2, 3]);
    vi.advanceTimersByTime(500);
    expect(s.others()).toEqual([]);
  });

  it("skips the gap when the wait runs out, and reports it with then: error", () => {
    const s = setup({ first: 0, gap: { wait: 100, then: "error" } });
    s.send(0, 3, 4, 6);
    vi.advanceTimersByTime(99);
    expect(s.delivered()).toEqual([0]);
    vi.advanceTimersByTime(1);
    expect(s.delivered()).toEqual([0, 3, 4]);
    expect(s.others()).toEqual([{ kind: "gap", from: 1, to: 2, reason: "timeout" }]);
    // The next gap (5) gets a wait of its own.
    vi.advanceTimersByTime(100);
    expect(s.delivered()).toEqual([0, 3, 4, 6]);
    expect(s.others()).toEqual([
      { kind: "gap", from: 1, to: 2, reason: "timeout" },
      { kind: "gap", from: 5, to: 5, reason: "timeout" },
    ]);
  });

  it("restarts the wait when the stream moves on", () => {
    const s = setup({ first: 0, gap: { wait: 100, then: "drop" } });
    s.send(0, 2, 4);
    vi.advanceTimersByTime(80);
    s.send(1); // delivers 1, 2; now waiting for 3
    vi.advanceTimersByTime(80);
    expect(s.delivered()).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(20);
    expect(s.delivered()).toEqual([0, 1, 2, 4]);
  });

  it("skips at once when more than maxBuffer chunks are held", () => {
    const s = setup({ first: 0, gap: { wait: 10_000, then: "error" }, maxBuffer: 2 });
    s.send(2, 3);
    expect(s.delivered()).toEqual([]);
    s.send(5);
    expect(s.delivered()).toEqual([2, 3]);
    expect(s.others()).toEqual([{ kind: "gap", from: 0, to: 1, reason: "overflow" }]);
    expect(s.stream.stats).toMatchObject({ overflows: 1, gaps: 2 });
  });

  it("tells duplicates from late chunks, and reports them only when asked", () => {
    const quiet = setup({ first: 0 });
    quiet.send(0, 0, 2, 2, 1);
    expect(quiet.others()).toEqual([]);
    expect(quiet.stream.stats).toMatchObject({ duplicates: 2, late: 1 });

    const loud = setup({ first: 0, duplicate: "error", late: "error", gap: { wait: 50, then: "drop" } });
    loud.send(0, 0, 2, 2);
    vi.advanceTimersByTime(50);
    loud.send(1);
    expect(loud.others()).toEqual([
      { kind: "duplicate", seq: 0 },
      { kind: "duplicate", seq: 2 }, // already held
      { kind: "late", seq: 1 },
    ]);
  });

  it("reports chunks that fail the boundary, and bad sequence numbers, and goes on", () => {
    const s = setup();
    s.stream.push(__unknown({ seq: "1", text: "x" }));
    s.stream.push(__unknown({ seq: 1.5, text: "x" }));
    s.send(1, 2);
    expect(s.others()).toEqual([
      { kind: "invalid", error: { kind: "decode", path: ["seq"], expected: "number", actual: "string", rule: "type" } },
      { kind: "invalid", error: { kind: "decode", path: [], expected: "a safe integer sequence number", actual: "1.5", rule: "value" } },
    ]);
    expect(s.delivered()).toEqual([1, 2]);
    expect(s.stream.stats.invalid).toBe(2);
  });

  it("starts a new numbering on reset, as after a reconnect", () => {
    const s = setup({ gap: { wait: 100, then: "drop" } });
    s.send(10, 11, 13);
    s.stream.reset();
    s.send(0, 1);
    vi.advanceTimersByTime(1000);
    expect(s.delivered()).toEqual([10, 11, 0, 1]);
    s.stream.reset(5);
    s.send(6);
    expect(s.delivered()).toEqual([10, 11, 0, 1]);
    s.send(5);
    expect(s.delivered()).toEqual([10, 11, 0, 1, 5, 6]);
  });

  it("ignores pushes after close, and its timer never fires", () => {
    const s = setup({ first: 0, gap: { wait: 100, then: "error" } });
    s.send(2);
    s.stream.close();
    vi.advanceTimersByTime(1000);
    s.send(0, 1);
    expect(s.events).toEqual([]);
  });

  it("lets onEvent push into the stream", () => {
    const events: number[] = [];
    const stream: ReturnType<typeof ChunkStream.of<Chunk>> = ChunkStream.of(Chunk, { seq: (c) => c.seq, first: 0 }, (e) => {
      if (e.kind !== "chunk") return;
      events.push(e.seq);
      if (e.seq === 0) stream.push(__unknown({ seq: 1, text: "" }));
    });
    stream.push(__unknown({ seq: 0, text: "" }));
    expect(events).toEqual([0, 1]);
  });

  it("rejects a policy it can't follow", () => {
    expect(() => ChunkStream.of(Chunk, { seq: (c) => c.seq, maxBuffer: 0 }, () => {})).toThrow(RangeError);
    expect(() => ChunkStream.of(Chunk, { seq: (c) => c.seq, gap: { wait: -1, then: "drop" } }, () => {})).toThrow(RangeError);
  });

  it("delivers strictly increasing numbers, each once, whatever the arrival order, and everything when nothing is lost", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }).chain((n) =>
          fc.record({
            n: fc.constant(n),
            // Arrival order: a shuffle of 0..n-1 with some repeats.
            order: fc.shuffledSubarray([...Array(n).keys(), ...Array(n).keys()], { minLength: n, maxLength: 2 * n }),
            wait: fc.constantFrom(0, 50),
            maxBuffer: fc.integer({ min: 1, max: 8 }),
          }),
        ),
        ({ n, order, wait, maxBuffer }) => {
          const s = setup({ first: 0, gap: { wait, then: "drop" }, maxBuffer });
          for (const seq of order) s.send(seq);
          vi.advanceTimersByTime(10_000);
          const got = s.delivered();
          for (let i = 1; i < got.length; i++) if (got[i]! <= got[i - 1]!) return false;
          // With every number present and an unlimited wait, nothing is skipped.
          const all = new Set(order).size === n;
          if (all && wait > 0 && maxBuffer >= n) return got.length === n;
          return got.every((x) => x >= 0 && x < n);
        },
      ),
    );
  });
});
