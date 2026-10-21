// The JavaScript side of the C ABI in src/wasm.rs, and the paths that skip it.
//
// Most text never reaches WebAssembly: tables.ts (generated from the crate, so
// for the same Unicode version) says which code points leave a string unchanged
// by NFC or NFD and which are always a grapheme cluster on their own, and a
// string made only of those is answered here. Everything else is copied into
// WASM memory as UTF-16 code units, the form JavaScript keeps strings in.
import type { TextCore, TextForm } from "@seamscript/runtime";
import { PROPS } from "./tables.js";

export interface CoreExports {
  memory: WebAssembly.Memory;
  seam_result(): number;
  seam_input(len: number): number;
  seam_normalize(len: number, form: number): number;
  seam_grapheme_count(len: number): number;
  seam_graphemes(len: number, limit: number): number;
  seam_unicode_version(): number;
}

export const NFC_SAFE = 1;
export const NFD_SAFE = 2;
export const SOLO = 4;

// The BMP has a table of its own (64 KB), so a scan costs one load per code
// unit. All code points are also in a two-level table, which is what code points
// outside the BMP are looked up in: `index` maps each block of 128 code points
// to a block of `data`, and a block inside a single run shares one of eight
// uniform blocks, so only blocks where the properties change take memory (36 KB
// in all). Built on first use. Surrogates have no properties, so an unpaired
// one always takes the WASM path.
const SHIFT = 7;
const BLOCK = 1 << SHIFT;
let bmp: Uint8Array | undefined;
let index: Uint16Array;
let data: Uint8Array;

function build(): Uint8Array {
  const ends: number[] = [];
  const props: number[] = [];
  let at = 0;
  for (const run of PROPS.split(",")) {
    at += parseInt(run.slice(1), 36);
    ends.push(at);
    props.push(run.charCodeAt(0) - 48);
  }
  index = new Uint16Array(0x110000 >> SHIFT);
  const mixed: number[] = []; // first code points of the blocks that are not uniform
  let r = 0;
  for (let b = 0; b < index.length; b++) {
    const start = b << SHIFT;
    while (ends[r]! <= start) r++;
    if (ends[r]! >= start + BLOCK) index[b] = props[r]!;
    else index[b] = 8 + mixed.push(start) - 1;
  }
  data = new Uint8Array((8 + mixed.length) << SHIFT);
  for (let p = 0; p < 8; p++) data.fill(p, p << SHIFT, (p + 1) << SHIFT);
  r = 0;
  mixed.forEach((start, k) => {
    for (let i = 0; i < BLOCK; i++) {
      while (ends[r]! <= start + i) r++;
      data[((8 + k) << SHIFT) | i] = props[r]!;
    }
  });
  const table = new Uint8Array(0x10000);
  for (let c = 0; c < 0x10000; c++) table[c] = data[(index[c >> SHIFT]! << SHIFT) | (c & (BLOCK - 1))]!;
  return (bmp = table);
}

function astral(cp: number): number {
  return data[(index[cp >> SHIFT]! << SHIFT) | (cp & (BLOCK - 1))]!;
}

/** The properties of one code point (for tests). */
export function propsOf(cp: number): number {
  const table = bmp ?? build();
  return cp < 0x10000 ? table[cp]! : astral(cp);
}

/** Code units taken by the code point at `i` if it has `bit`, else 0. */
function width(s: string, i: number, bit: number, table: Uint8Array): number {
  const c = s.charCodeAt(i);
  if ((table[c]! & bit) !== 0) return 1;
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff && (astral(((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000) & bit) !== 0) return 2;
  }
  return 0;
}

/** The number of code points in `s` if every one has `bit`, else -1. */
function scan(s: string, bit: number): number {
  const table = bmp ?? build();
  const blocks = index;
  const astralTable = data;
  const len = s.length;
  let n = len;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if ((table[c]! & bit) !== 0) continue;
    // A surrogate pair, looked up as one code point (inline: this loop is hot).
    if (c < 0xd800 || c > 0xdbff || i + 1 === len) return -1;
    const low = s.charCodeAt(i + 1);
    if (low < 0xdc00 || low > 0xdfff) return -1;
    const cp = ((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
    if ((astralTable[(blocks[cp >> SHIFT]! << SHIFT) | (cp & (BLOCK - 1))]! & bit) === 0) return -1;
    i++;
    n--;
  }
  return n;
}

/**
 * The first `limit + 1` grapheme boundaries of `s` (all, if there are fewer)
 * while they fall between solo code points, or `undefined` once one does not.
 * Between two solo code points there is always a boundary, whatever precedes
 * them (src/props.rs), so this needs to look only one code point ahead.
 */
function soloBoundaries(s: string, limit: number): number[] | undefined {
  const table = bmp ?? build();
  const out = [0];
  let i = 0;
  let w = s.length === 0 ? 0 : width(s, 0, SOLO, table);
  while (out.length <= limit && i < s.length) {
    if (w === 0) return undefined;
    i += w;
    w = i < s.length ? width(s, i, SOLO, table) : 0;
    if (i < s.length && w === 0) return undefined;
    out.push(i);
  }
  return out;
}

/**
 * Two generations of Maps: a hit costs one lookup, and a full generation
 * replaces the older one. A generation ends after 128 entries or about 1M code
 * units of keys and values, so the cache stays small whatever it is given.
 */
class Cache<V extends number | string | readonly number[]> {
  private young = new Map<string, V>();
  private old = new Map<string, V>();
  private units = 0;

  get(key: string): V | undefined {
    let hit = this.young.get(key);
    if (hit === undefined && (hit = this.old.get(key)) !== undefined) this.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    const units = key.length + (typeof value === "number" ? 0 : value.length);
    if (this.young.size >= 128 || this.units + units > 1 << 20) {
      this.old = this.young;
      this.young = new Map();
      this.units = 0;
    }
    this.young.set(key, value);
    this.units += units;
  }
}

/**
 * From this length on, a string is looked up in a cache before it is scanned:
 * scanning costs a few nanoseconds per code unit, a lookup about one hash (which
 * the engine keeps with the string once computed).
 */
const LONG = 256;

const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** `shortcuts: false` sends everything through WebAssembly, which tests compare against. */
export function createCore(x: CoreExports, { shortcuts = true }: { shortcuts?: boolean } = {}): TextCore {
  // WASM memory is little-endian; typed arrays use the host's byte order.
  if (!isLittleEndian) throw new Error("@seamscript/core: big-endian hosts are not supported");

  // Views of the whole memory, replaced when it grows: growing detaches the old
  // buffer, which leaves every view of it with length 0.
  let u16 = new Uint16Array(x.memory.buffer);
  let u32 = new Uint32Array(x.memory.buffer);
  const fresh = () => {
    if (u16.length === 0) {
      u16 = new Uint16Array(x.memory.buffer);
      u32 = new Uint32Array(x.memory.buffer);
    }
  };
  const slot = x.seam_result() >>> 2;

  /** Copies the first `len` code units of `s` into the input buffer. */
  const write = (s: string, len: number) => {
    const at = x.seam_input(len) >>> 1;
    fresh();
    const view = u16;
    for (let i = 0; i < len; i++) view[at + i] = s.charCodeAt(i);
  };

  // ignoreBOM: a leading U+FEFF is text, not a byte-order mark to drop.
  const utf16 = new TextDecoder("utf-16le", { ignoreBOM: true });
  const readString = (): string => {
    fresh();
    const at = u32[slot]! >>> 1;
    const view = u16.subarray(at, at + u32[slot + 1]!);
    // fromCharCode is quicker for short strings and limited by the argument count.
    return view.length <= 1024 ? String.fromCharCode.apply(null, view as unknown as number[]) : utf16.decode(view);
  };

  const readBoundaries = (): number[] => {
    fresh();
    const at = u32[slot]! >>> 2;
    const n = u32[slot + 1]!;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = u32[at + i]!;
    return out;
  };

  const segmentation = new Cache<number | readonly number[]>();
  const normalized = { NFC: new Cache<string>(), NFD: new Cache<string>() };

  const allBoundaries = (s: string): readonly number[] => {
    const hit = segmentation.get(s);
    if (typeof hit === "object") return hit;
    write(s, s.length);
    x.seam_graphemes(s.length, 0xffffffff);
    const b = readBoundaries();
    segmentation.set(s, b);
    return b;
  };

  // The first `limit + 1` boundaries, computed from a prefix of `s` when that is
  // much shorter. A boundary at p depends only on s[..p] and the code point at p
  // (UAX #29's rules look back, never more than one code point ahead), so every
  // boundary of a prefix except its end is a boundary of `s`. The prefix doubles
  // until the boundaries wanted fall before its end.
  const someBoundaries = (s: string, limit: number): readonly number[] => {
    const hit = segmentation.get(s);
    if (typeof hit === "object") return hit.length > limit + 1 ? hit.slice(0, limit + 1) : hit;
    for (let len = Math.max(64, limit * 8); ; len *= 2) {
      if (len >= s.length / 2) return allBoundaries(s).slice(0, limit + 1);
      // Never split a surrogate pair.
      const cut = s.charCodeAt(len - 1) >= 0xd800 && s.charCodeAt(len - 1) <= 0xdbff ? len + 1 : len;
      write(s, cut);
      x.seam_graphemes(cut, limit);
      const b = readBoundaries();
      if (b.length === limit + 1 && b[limit]! < cut) return b;
    }
  };

  const v = x.seam_unicode_version();
  return {
    unicodeVersion: `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`,

    normalize(s: string, form: TextForm): string {
      const long = s.length >= LONG;
      const hit = long ? normalized[form].get(s) : undefined;
      if (hit !== undefined) return hit;
      let out = s;
      if (!shortcuts || scan(s, form === "NFC" ? NFC_SAFE : NFD_SAFE) < 0) {
        write(s, s.length);
        if (x.seam_normalize(s.length, form === "NFC" ? 0 : 1) !== 0) out = readString();
      }
      if (long) normalized[form].set(s, out);
      return out;
    },

    graphemeCount(s: string): number {
      const long = s.length >= LONG;
      if (!long && shortcuts) {
        const n = scan(s, SOLO);
        if (n >= 0) return n;
      }
      const hit = segmentation.get(s);
      if (hit !== undefined) return typeof hit === "number" ? hit : hit.length - 1;
      let n = long && shortcuts ? scan(s, SOLO) : -1;
      if (n < 0) {
        write(s, s.length);
        n = x.seam_grapheme_count(s.length);
      }
      segmentation.set(s, n);
      return n;
    },

    graphemeBoundaries(s: string, limit?: number): readonly number[] {
      const max = limit === undefined ? s.length : Math.min(limit, s.length);
      return (shortcuts ? soloBoundaries(s, max) : undefined) ?? (max < s.length ? someBoundaries(s, max) : allBoundaries(s));
    },
  };
}
