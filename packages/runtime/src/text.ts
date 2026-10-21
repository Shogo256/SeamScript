import type { Brand } from "./brand.js";

declare const form: unique symbol;

export type TextForm = "NFC" | "NFD";

export type TextStatus = "core" | "host" | "loading" | "failed";

/**
 * String APIs that count UTF-16 code units. Calling any of them fails to type-check.
 * Reading `length` or an index only yields `never`, which TypeScript does not
 * reject on its own; the compiler's checker pass turns those reads into errors.
 */
type CodeUnitApi = {
  readonly length: never;
  readonly [index: number]: never;
  readonly at: never;
  readonly charAt: never;
  readonly charCodeAt: never;
  readonly codePointAt: never;
  readonly slice: never;
  readonly substring: never;
  readonly substr: never;
  readonly indexOf: never;
  readonly lastIndexOf: never;
  readonly search: never;
  readonly padStart: never;
  readonly padEnd: never;
  readonly [Symbol.iterator]: never;
};

/**
 * A string normalized to `F`, measured in grapheme clusters. At runtime it is the
 * plain string, so `===`, Map keys, JSX children and template literals just work.
 */
export type Text<F extends TextForm> = string & Brand<"Text"> & { readonly [form]: F } & CodeUnitApi;

/** What `@seamscript/core` provides once its WASM module is instantiated. */
export interface TextCore {
  /** Replaces lone surrogates with U+FFFD as well. */
  normalize(s: string, form: TextForm): string;
  /** The number of grapheme clusters in `s`. */
  graphemeCount(s: string): number;
  /**
   * UTF-16 offsets of grapheme boundaries: 0, then the end of each cluster. With
   * `limit`, only the first `limit + 1` (all of them if `s` has fewer clusters),
   * which lets the core stop early on a long string.
   */
  graphemeBoundaries(s: string, limit?: number): ArrayLike<number>;
  readonly unicodeVersion: string;
}

export class CoreUnavailableError extends Error {
  override readonly name = "CoreUnavailableError";
  /** `true` while `@seamscript/core/deferred` is still loading: awaiting `Text.ready` fixes it. */
  readonly loading: boolean;
  constructor(cause: unknown, loading = false) {
    super(
      loading
        ? "@seamscript/core is still loading; await Text.ready before the first Text operation."
        : "@seamscript/core could not be loaded, so Text cannot be normalized or segmented " +
            "deterministically. Check that the page's CSP allows 'wasm-unsafe-eval'.",
      { cause },
    );
    this.loading = loading;
  }
}

type Backend = Omit<TextCore, "unicodeVersion">;

let core: TextCore | undefined;
let coreFailure: { cause: unknown } | undefined;
let coreLoading: Promise<void> | undefined;

/** Called by `@seamscript/core` after its WASM module is ready. */
export function __installCore(c: TextCore): void {
  core = c;
  coreFailure = undefined;
}

/**
 * Called by `@seamscript/core/deferred` with the load it started, which settles
 * once the core is installed or has failed. Until then Text operations throw
 * CoreUnavailableError with `loading: true`.
 */
export function __coreLoading(done: Promise<void>): void {
  if (core !== undefined) return;
  coreLoading = done;
  void done.then(() => {
    if (coreLoading === done) coreLoading = undefined;
  });
}

/**
 * Called by `@seamscript/core` when instantiation fails. From then on Text
 * operations throw `CoreUnavailableError` instead of silently falling back.
 */
export function __coreFailed(cause: unknown): void {
  core = undefined;
  coreFailure = { cause };
}

// Printable ASCII never joins into larger clusters in any Unicode version, so
// every code unit is a cluster, with or without Unicode data.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function asciiBoundaries(s: string, limit: number): number[] {
  const n = Math.min(limit, s.length);
  const out = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) out[i] = i;
  return out;
}

let segmenter: Intl.Segmenter | null | undefined;

function hostSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

// Development fallback: whatever Unicode version the host's ICU implements
// (code points where there is no Intl.Segmenter).
const fallback: Backend = {
  // String.prototype.normalize keeps lone surrogates; the core replaces them.
  normalize: (s, f) => toWellFormed(s).normalize(f),
  graphemeCount(s) {
    if (PRINTABLE_ASCII.test(s)) return s.length;
    let n = 0;
    for (const _ of hostSegmenter()?.segment(s) ?? s) n++;
    return n;
  },
  graphemeBoundaries(s, limit = Infinity) {
    if (PRINTABLE_ASCII.test(s)) return asciiBoundaries(s, limit);
    const out: number[] = [];
    const seg = hostSegmenter();
    // Each cluster's start; the start of cluster `limit` is the end of the last one wanted.
    if (seg !== null) {
      for (const { index } of seg.segment(s)) if (out.push(index) > limit) return out;
    } else {
      let i = 0;
      for (const cp of s) {
        if (out.push(i) > limit) return out;
        i += cp.length;
      }
    }
    out.push(s.length);
    return out;
  },
};

// After a failed load only what needs no Unicode data still works.
const unavailable: Backend = {
  normalize() {
    throw new CoreUnavailableError(coreFailure?.cause);
  },
  graphemeCount(s) {
    if (PRINTABLE_ASCII.test(s)) return s.length;
    throw new CoreUnavailableError(coreFailure?.cause);
  },
  graphemeBoundaries(s, limit = Infinity) {
    if (PRINTABLE_ASCII.test(s)) return asciiBoundaries(s, limit);
    throw new CoreUnavailableError(coreFailure?.cause);
  },
};

// While @seamscript/core/deferred loads: like a failed load, but awaiting Text.ready fixes it.
const loading: Backend = {
  normalize() {
    throw new CoreUnavailableError(undefined, true);
  },
  graphemeCount(s) {
    if (PRINTABLE_ASCII.test(s)) return s.length;
    throw new CoreUnavailableError(undefined, true);
  },
  graphemeBoundaries(s, limit = Infinity) {
    if (PRINTABLE_ASCII.test(s)) return asciiBoundaries(s, limit);
    throw new CoreUnavailableError(undefined, true);
  },
};

function backend(): Backend {
  return core ?? (coreFailure !== undefined ? unavailable : coreLoading !== undefined ? loading : fallback);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

export function isWellFormed(s: string): boolean {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s);
}

function toWellFormed(s: string): string {
  return typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(LONE_SURROGATES, "\uFFFD");
}

/** Used by the decoder: `undefined` when `s` is not well-formed UTF-16. */
export function decodeText<F extends TextForm>(s: string, f: F): Text<F> | undefined {
  return isWellFormed(s) ? (backend().normalize(s, f) as Text<F>) : undefined;
}

// Array.prototype.slice's handling of relative indices.
function relative(index: number, n: number): number {
  return index < 0 ? Math.max(n + index, 0) : Math.min(index, n);
}

function make<F extends TextForm>(f: F, parts: readonly string[]): Text<F> {
  // Joining normalized strings can produce an unnormalized one ("e" + "\u0301"), so
  // normalization runs on the whole. Unlike decode, construction never fails:
  // every backend's normalize replaces lone surrogates with U+FFFD, as any UTF-8
  // based implementation would.
  return backend().normalize(parts.length === 1 ? parts[0]! : parts.join(""), f) as Text<F>;
}

export const Text = {
  /** Joins `parts` and normalizes the result to NFC. */
  nfc(...parts: readonly string[]): Text<"NFC"> {
    return make("NFC", parts);
  },

  /** Joins `parts` and normalizes the result to NFD. */
  nfd(...parts: readonly string[]): Text<"NFD"> {
    return make("NFD", parts);
  },

  /** Number of grapheme clusters. */
  length(t: Text<TextForm>): number {
    return backend().graphemeCount(t);
  },

  /** The grapheme cluster at `index`; negative indices count from the end. */
  at<F extends TextForm>(t: Text<F>, index: number): Text<F> | undefined {
    const s: string = t;
    let i = Math.trunc(index) || 0;
    // From the start, only the clusters up to `i` are needed.
    const b = i >= 0 ? backend().graphemeBoundaries(s, i + 1) : backend().graphemeBoundaries(s);
    if (i < 0) i += b.length - 1;
    if (i < 0 || i + 1 >= b.length) return undefined;
    return s.slice(b[i], b[i + 1]) as Text<F>;
  },

  /** Like `Array.prototype.slice`, over grapheme clusters. */
  slice<F extends TextForm>(t: Text<F>, start: number = 0, end?: number): Text<F> {
    const s: string = t;
    const a = Math.trunc(start) || 0;
    const e = end === undefined ? undefined : Math.trunc(end) || 0;
    // Cut at grapheme boundaries, a piece of a normalized string is itself
    // normalized: no combining sequence is split (checked in properties.test.ts).
    if (a >= 0 && e === undefined) {
      // Everything from cluster `a` on: only the first `a` clusters are needed.
      const b = backend().graphemeBoundaries(s, a);
      return (a < b.length ? s.slice(b[a]) : "") as Text<F>;
    }
    if (a >= 0 && e !== undefined && e >= 0) {
      if (e <= a) return "" as Text<F>;
      const b = backend().graphemeBoundaries(s, e);
      const n = b.length - 1; // min(e, number of clusters)
      return (a >= n ? "" : s.slice(b[a], b[Math.min(e, n)])) as Text<F>;
    }
    // A negative index counts from the end, which needs every boundary.
    const b = backend().graphemeBoundaries(s);
    const n = b.length - 1;
    const from = relative(a, n);
    const to = e === undefined ? n : relative(e, n);
    return (to <= from ? "" : s.slice(b[from], b[to])) as Text<F>;
  },

  graphemes<F extends TextForm>(t: Text<F>): Text<F>[] {
    const s: string = t;
    const b = backend().graphemeBoundaries(s);
    const out: Text<F>[] = [];
    for (let i = 0; i + 1 < b.length; i++) out.push(s.slice(b[i], b[i + 1]) as Text<F>);
    return out;
  },

  /** Unicode version of the loaded core, or `null` when running on the host's ICU. */
  get unicodeVersion(): string | null {
    return core?.unicodeVersion ?? null;
  },

  /** `true` only when normalization and segmentation come from `@seamscript/core`. */
  get deterministic(): boolean {
    return core !== undefined;
  },

  /**
   * Where Text's Unicode data comes from: `"core"` (the WASM core, as in a
   * production build), `"host"` (the environment's ICU, as in development), or
   * `"loading"` (`@seamscript/core/deferred` is loading; await `Text.ready`), or
   * `"failed"` (the core could not load; Text operations throw
   * CoreUnavailableError). An app checks this at start-up to stop with a message
   * instead of failing on its first Text operation.
   */
  get status(): TextStatus {
    return core !== undefined ? "core" : coreFailure !== undefined ? "failed" : coreLoading !== undefined ? "loading" : "host";
  },

  /**
   * Settles once `@seamscript/core/deferred` has finished loading (status is then
   * `"core"`, or `"failed"`); already settled when nothing is loading. Never rejects.
   */
  get ready(): Promise<void> {
    return coreLoading ?? Promise.resolve();
  },
};
