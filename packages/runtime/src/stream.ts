import type { Decoder } from "./decoder.js";
import type { DecodeError } from "./result.js";
import type { Unknown } from "./unknown.js";

/** What to do with a chunk the stream can't deliver in order. */
export type StreamAction = "drop" | "error";

/**
 * How a `ChunkStream` treats a sequence of numbered chunks. Every chunk passes the
 * boundary first; these rules apply to the ones that did.
 */
export interface StreamPolicy<T> {
  /** The chunk's sequence number: a safe integer, one higher for each chunk. */
  seq(chunk: T): number;
  /** The first sequence number. Default: the number of the first chunk that arrives (after `reset()`, too). */
  first?: number;
  /**
   * A missing number with later chunks already here: wait up to `wait` ms for it
   * (later chunks are held meanwhile), then skip it. `then: "error"` also reports
   * the skipped range as a `gap` event. Default `{ wait: 0, then: "drop" }`: skip
   * at once.
   */
  gap?: { wait: number; then: StreamAction };
  /** A number already delivered, or already held, arrives again. Default `"drop"`. */
  duplicate?: StreamAction;
  /** A number that was skipped as a gap arrives after all. Default `"drop"`. */
  late?: StreamAction;
  /** Held chunks at most; one more skips the oldest gap at once (`reason: "overflow"`). Default 64. */
  maxBuffer?: number;
}

export type StreamEvent<T> =
  /** The next chunk in order. */
  | { kind: "chunk"; seq: number; value: T }
  /** `from`..`to` (inclusive) were skipped. Only with `gap.then: "error"`. */
  | { kind: "gap"; from: number; to: number; reason: "timeout" | "overflow" }
  /** Only with `duplicate: "error"`. */
  | { kind: "duplicate"; seq: number }
  /** Only with `late: "error"`. */
  | { kind: "late"; seq: number }
  /** A chunk that failed its boundary, or whose sequence number is not a safe integer. Always reported. */
  | { kind: "invalid"; error: DecodeError };

/** Counts since the stream was made; dropped chunks show up only here. */
export interface StreamStats {
  delivered: number;
  /** Sequence numbers skipped. */
  gaps: number;
  /** Gaps skipped because the buffer was full. */
  overflows: number;
  duplicates: number;
  late: number;
  invalid: number;
}

export interface ChunkStream<T> {
  /** Decodes one chunk and delivers whatever is now in order. Takes Unknown: the boundary is the stream's first step. */
  push(raw: Unknown): void;
  /**
   * Starts a new numbering (after a reconnect, or a server restart): forgets held
   * and skipped chunks, and expects `next`, or (without it) whatever arrives next.
   */
  reset(next?: number): void;
  /** Stops the wait timer and ignores later pushes. */
  close(): void;
  readonly stats: Readonly<StreamStats>;
}

// Skipped ranges remembered to tell a late chunk from a duplicate; older ones count as duplicates.
const MAX_SKIPPED = 256;

/**
 * A boundary for a sequence of chunks rather than a single value: each chunk is
 * decoded with `decoder`, and the stream delivers them to `onEvent` in sequence
 * order, once each, holding early ones while a gap may still fill. Missing,
 * repeated and late chunks are handled as `policy` says; by default they are
 * dropped and only counted in `stats`.
 *
 * Events are delivered synchronously from `push` (and from the wait timer), after
 * the stream's state is updated, so `onEvent` may call `push` or `reset` itself.
 */
function of<T>(decoder: Decoder<T>, policy: StreamPolicy<T>, onEvent: (event: StreamEvent<T>) => void): ChunkStream<T> {
  const wait = policy.gap?.wait ?? 0;
  const onGap = policy.gap?.then ?? "drop";
  const onDuplicate = policy.duplicate ?? "drop";
  const onLate = policy.late ?? "drop";
  const maxBuffer = policy.maxBuffer ?? 64;
  if (!(wait >= 0) || !Number.isFinite(wait)) throw new RangeError(`ChunkStream: gap.wait must be a non-negative number of ms, not ${wait}`);
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) throw new RangeError(`ChunkStream: maxBuffer must be a positive integer, not ${maxBuffer}`);
  if (policy.first !== undefined && !Number.isSafeInteger(policy.first)) throw new RangeError(`ChunkStream: first must be a safe integer, not ${policy.first}`);

  const stats: StreamStats = { delivered: 0, gaps: 0, overflows: 0, duplicates: 0, late: 0, invalid: 0 };
  let expected: number | undefined = policy.first;
  const held = new Map<number, T>();
  // Disjoint, in the order they were skipped (which is ascending).
  let skipped: [number, number][] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const out: StreamEvent<T>[] = [];

  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  // Whatever is now in order, from `expected` on.
  const drain = () => {
    for (let v = held.get(expected!); v !== undefined || held.has(expected!); v = held.get(expected!)) {
      held.delete(expected!);
      stats.delivered++;
      out.push({ kind: "chunk", seq: expected!, value: v as T });
      expected!++;
    }
  };

  // Gives up on the numbers before the lowest held chunk.
  const skip = (reason: "timeout" | "overflow") => {
    let lowest = Infinity;
    for (const k of held.keys()) if (k < lowest) lowest = k;
    const from = expected!;
    const to = lowest - 1;
    skipped.push([from, to]);
    if (skipped.length > MAX_SKIPPED) skipped = skipped.slice(-MAX_SKIPPED);
    stats.gaps += to - from + 1;
    if (reason === "overflow") stats.overflows++;
    if (onGap === "error") out.push({ kind: "gap", from, to, reason });
    expected = lowest;
    drain();
  };

  const wasSkipped = (seq: number) => {
    for (let i = skipped.length - 1; i >= 0; i--) {
      const [from, to] = skipped[i]!;
      if (seq >= from && seq <= to) return true;
      if (to < seq) return false; // ranges are ascending: no earlier one can hold it
    }
    return false;
  };

  // After each change: wait for the gap (anew once the stream moved on), or skip it now.
  const schedule = (moved: boolean) => {
    if (held.size === 0) return stopTimer();
    if (wait === 0) {
      while (held.size > 0) skip("timeout");
      return;
    }
    if (moved) stopTimer();
    timer ??= setTimeout(() => {
      timer = undefined;
      if (closed || held.size === 0) return;
      skip("timeout");
      schedule(true);
      flush();
    }, wait);
  };

  const flush = () => {
    if (out.length === 0) return;
    const events = out.splice(0);
    for (const e of events) onEvent(e);
  };

  const invalid = (error: DecodeError) => {
    stats.invalid++;
    out.push({ kind: "invalid", error });
  };

  return {
    push(raw) {
      if (closed) return;
      const r = decoder.decode(raw);
      if (!r.ok) {
        invalid(r.error);
        return flush();
      }
      const seq = policy.seq(r.value);
      if (!Number.isSafeInteger(seq)) {
        invalid({ kind: "decode", path: [], expected: "a safe integer sequence number", actual: String(seq), rule: "value" });
        return flush();
      }
      expected ??= seq;
      const before = expected;
      if (seq < expected) {
        if (wasSkipped(seq)) {
          stats.late++;
          if (onLate === "error") out.push({ kind: "late", seq });
        } else {
          stats.duplicates++;
          if (onDuplicate === "error") out.push({ kind: "duplicate", seq });
        }
      } else if (held.has(seq)) {
        stats.duplicates++;
        if (onDuplicate === "error") out.push({ kind: "duplicate", seq });
      } else {
        held.set(seq, r.value);
        drain();
        while (held.size > maxBuffer) skip("overflow");
      }
      schedule(expected !== before);
      flush();
    },
    reset(next) {
      if (next !== undefined && !Number.isSafeInteger(next)) throw new RangeError(`ChunkStream: reset takes a safe integer, not ${next}`);
      stopTimer();
      held.clear();
      skipped = [];
      expected = next;
    },
    close() {
      closed = true;
      stopTimer();
      held.clear();
    },
    get stats() {
      return { ...stats };
    },
  };
}

export const ChunkStream = { of } as const;
