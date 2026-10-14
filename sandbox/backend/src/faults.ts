// What can go wrong between the market and the app. Every field defaults to
// "nothing goes wrong"; tests switch faults on through POST /admin/faults.

export interface WsFaults {
  /** Delay before each frame is sent, plus up to `jitterMs` more. Frames stay in order. */
  latencyMs: number;
  jitterMs: number;
  /** Probability that a frame is never sent. */
  dropRate: number;
  /** Probability that a frame is sent twice. */
  duplicateRate: number;
  /** Probability that a frame is cut short (always invalid JSON). */
  corruptRate: number;
  /** Probability, per value, of a schema the app does not accept (UUID order ids, numeric prices). */
  driftRate: number;
  /** Probability, per value, of an equivalent spelling (numbers for ids, NFD, other offsets, trailing zeros). */
  variantRate: number;
  /** Probability that a frame is sent as a binary frame instead of text. */
  binaryRate: number;
  /** Frames are collected into groups of this size and sent shuffled. 0 or 1: off. */
  reorderWindow: number;
  /** A partly filled group is sent after this long. */
  reorderHoldMs: number;
  /** Probability that a frame carries an extra field of `padBytes` characters. */
  padRate: number;
  padBytes: number;
  /** Close every connection this often (0: never). */
  disconnectEveryMs: number;
  /** "close" sends a close frame; "terminate" drops the TCP connection without one. */
  disconnectMode: "close" | "terminate";
  /** After a disconnect, refuse new connections for this long. */
  refuseMs: number;
}

export interface HttpFaults {
  latencyMs: number;
  jitterMs: number;
  /** Probability of a 500 response. */
  errorRate: number;
  /** Probability that a JSON body is cut short. */
  corruptRate: number;
  driftRate: number;
  variantRate: number;
  /** Size of an extra field in every JSON body (0: none). */
  padBytes: number;
  /** Nesting depth of an extra field in every JSON body (0: none). */
  deepNesting: number;
  /** Delays for the next search requests, consumed in order (for latest tests). */
  searchDelays: number[];
  /** Delays for the next order detail requests, consumed in order. */
  detailDelays: number[];
  /** Probability that POST /api/orders commits the order and then answers 500. */
  commitThenFailRate: number;
}

export interface Faults {
  ws: WsFaults;
  http: HttpFaults;
  /**
   * Content-Security-Policy for the app's pages. "wasm" allows the WASM core
   * ('wasm-unsafe-eval'); "strict" does not, so the core fails to load.
   */
  csp: "none" | "wasm" | "strict";
}

export function noFaults(): Faults {
  return {
    ws: {
      latencyMs: 0,
      jitterMs: 0,
      dropRate: 0,
      duplicateRate: 0,
      corruptRate: 0,
      driftRate: 0,
      variantRate: 0,
      binaryRate: 0,
      reorderWindow: 0,
      reorderHoldMs: 30,
      padRate: 0,
      padBytes: 0,
      disconnectEveryMs: 0,
      disconnectMode: "close",
      refuseMs: 0,
    },
    http: {
      latencyMs: 0,
      jitterMs: 0,
      errorRate: 0,
      corruptRate: 0,
      driftRate: 0,
      variantRate: 0,
      padBytes: 0,
      deepNesting: 0,
      searchDelays: [],
      detailDelays: [],
      commitThenFailRate: 0,
    },
    csp: "wasm",
  };
}

export type FaultsPatch = { ws?: Partial<WsFaults>; http?: Partial<HttpFaults>; csp?: Faults["csp"] };

/** Applies a patch, rejecting keys and value types that do not exist (a typo must not silently test nothing). */
export function patchFaults(current: Faults, patch: unknown): Faults | string {
  if (!isRecord(patch)) return "body must be an object";
  const next: Faults = { ws: { ...current.ws }, http: { ...current.http, searchDelays: [...current.http.searchDelays], detailDelays: [...current.http.detailDelays] }, csp: current.csp };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "csp") {
      if (value !== "none" && value !== "wasm" && value !== "strict") return "csp must be none, wasm or strict";
      next.csp = value;
    } else if (key === "ws" || key === "http") {
      if (!isRecord(value)) return `${key} must be an object`;
      const target = next[key] as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(value)) {
        if (!(k in target)) return `unknown fault ${key}.${k}`;
        const old = target[k];
        if (Array.isArray(old) ? !(Array.isArray(v) && v.every((x) => typeof x === "number")) : typeof v !== typeof old) {
          return `${key}.${k} must be ${Array.isArray(old) ? "a number array" : `a ${typeof old}`}`;
        }
        target[k] = v;
      }
    } else {
      return `unknown fault section ${key}`;
    }
  }
  return next;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
