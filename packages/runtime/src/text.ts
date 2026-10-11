import type { Brand } from "./brand.js";

declare const form: unique symbol;

export type TextForm = "NFC" | "NFD";

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
  normalize(s: string, form: TextForm): string;
  /** UTF-16 offsets of every grapheme boundary, starting at 0 and ending at `s.length`. */
  graphemeBoundaries(s: string): ArrayLike<number>;
  readonly unicodeVersion: string;
}

export class CoreUnavailableError extends Error {
  override readonly name = "CoreUnavailableError";
  constructor(cause: unknown) {
    super(
      "@seamscript/core could not be loaded, so Text cannot be normalized or segmented " +
        "deterministically. Check that the page's CSP allows 'wasm-unsafe-eval'.",
      { cause },
    );
  }
}

type Backend = Pick<TextCore, "normalize" | "graphemeBoundaries">;

let core: TextCore | undefined;
let coreFailure: { cause: unknown } | undefined;

/** Called by `@seamscript/core` after its WASM module is ready. */
export function __installCore(c: TextCore): void {
  core = c;
  coreFailure = undefined;
  cache.clear();
}

/**
 * Called by `@seamscript/core` when instantiation fails. From then on Text
 * operations throw `CoreUnavailableError` instead of silently falling back.
 */
export function __coreFailed(cause: unknown): void {
  core = undefined;
  coreFailure = { cause };
  cache.clear();
}

let segmenter: Intl.Segmenter | null | undefined;

// Development fallback: whatever Unicode version the host's ICU implements.
const fallback: Backend = {
  normalize: (s, f) => s.normalize(f),
  graphemeBoundaries(s) {
    if (segmenter === undefined) {
      segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
    }
    const out: number[] = [];
    if (segmenter !== null) {
      for (const { index } of segmenter.segment(s)) out.push(index);
    } else {
      let i = 0;
      for (const cp of s) {
        out.push(i);
        i += cp.length;
      }
    }
    out.push(s.length);
    return out;
  },
};

function backend(): Backend {
  if (core !== undefined) return core;
  if (coreFailure !== undefined) throw new CoreUnavailableError(coreFailure.cause);
  return fallback;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

export function isWellFormed(s: string): boolean {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s);
}

function toWellFormed(s: string): string {
  return typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(LONE_SURROGATES, "�");
}

/** Used by the decoder: `undefined` when `s` is not well-formed UTF-16. */
export function decodeText<F extends TextForm>(s: string, f: F): Text<F> | undefined {
  return isWellFormed(s) ? (backend().normalize(s, f) as Text<F>) : undefined;
}

// Printable ASCII never joins into larger clusters in any Unicode version, so
// boundaries are simply every code unit. Covers most identifiers and UI strings.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const CACHE_SIZE = 256;
const cache = new Map<string, ArrayLike<number>>();

/** `null` means every code unit is its own grapheme. */
function offsets(s: string): ArrayLike<number> | null {
  if (PRINTABLE_ASCII.test(s)) return null;
  const hit = cache.get(s);
  if (hit !== undefined) {
    cache.delete(s);
    cache.set(s, hit);
    return hit;
  }
  const b = backend().graphemeBoundaries(s);
  cache.set(s, b);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return b;
}

function count(s: string, b: ArrayLike<number> | null): number {
  return b === null ? s.length : b.length - 1;
}

function offsetAt(b: ArrayLike<number> | null, i: number): number {
  return b === null ? i : b[i]!;
}

// Array.prototype.slice's handling of relative indices.
function relative(index: number, n: number): number {
  const i = Math.trunc(index) || 0;
  return i < 0 ? Math.max(n + i, 0) : Math.min(i, n);
}

function make<F extends TextForm>(f: F, parts: readonly string[]): Text<F> {
  // Joining normalized strings can produce an unnormalized one ("e" + "́"), so
  // normalization runs on the whole. Unlike decode, construction never fails:
  // lone surrogates become U+FFFD, as they would in any UTF-8 based backend.
  return backend().normalize(toWellFormed(parts.join("")), f) as Text<F>;
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
    const s: string = t;
    return count(s, offsets(s));
  },

  /** The grapheme cluster at `index`; negative indices count from the end. */
  at<F extends TextForm>(t: Text<F>, index: number): Text<F> | undefined {
    const s: string = t;
    const b = offsets(s);
    const n = count(s, b);
    let i = Math.trunc(index) || 0;
    if (i < 0) i += n;
    if (i < 0 || i >= n) return undefined;
    return s.slice(offsetAt(b, i), offsetAt(b, i + 1)) as Text<F>;
  },

  /** Like `Array.prototype.slice`, over grapheme clusters. */
  slice<F extends TextForm>(t: Text<F>, start: number = 0, end?: number): Text<F> {
    const s: string = t;
    const b = offsets(s);
    const n = count(s, b);
    const from = relative(start, n);
    const to = end === undefined ? n : relative(end, n);
    // Cut at grapheme boundaries, a piece of a normalized string is itself
    // normalized: no combining sequence is split (checked in properties.test.ts).
    return (to <= from ? "" : s.slice(offsetAt(b, from), offsetAt(b, to))) as Text<F>;
  },

  graphemes<F extends TextForm>(t: Text<F>): Text<F>[] {
    const s: string = t;
    const b = offsets(s);
    const n = count(s, b);
    const out: Text<F>[] = [];
    for (let i = 0; i < n; i++) out.push(s.slice(offsetAt(b, i), offsetAt(b, i + 1)) as Text<F>);
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
};
