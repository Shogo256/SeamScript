// The JavaScript side answers most strings without WebAssembly (js/core.ts).
// Every answer must be the one WebAssembly would give: these compare a core with
// the shortcuts against one without, on strings built to hit every path.
import fc from "fast-check";
import { Text, type TextCore } from "@seamscript/runtime";
import { beforeAll, expect, it } from "vitest";
import { type CoreExports, createCore, propsOf } from "../js/core.js";
import { decodeBase64, install } from "../js/load.js";
import { PROPS } from "../js/tables.js";
import { WASM_BASE64 } from "../js/wasm.js";

let fast: TextCore;
let slow: TextCore; // asked for everything at once: the reference
let slowSome: TextCore; // asked only for the first boundaries: takes the prefix path
beforeAll(async () => {
  const bytes = decodeBase64(WASM_BASE64);
  const make = async (shortcuts: boolean) =>
    createCore((await WebAssembly.instantiate(bytes)).instance.exports as unknown as CoreExports, { shortcuts });
  [fast, slow, slowSome] = await Promise.all([make(true), make(false), make(false)]);
  await install(bytes);
});

it("looks up every code point as the generated runs say", () => {
  const failures: number[] = [];
  let at = 0;
  for (const run of PROPS.split(",")) {
    const p = run.charCodeAt(0) - 48;
    const end = at + parseInt(run.slice(1), 36);
    for (let cp = at; cp < end; cp++) if (propsOf(cp) !== p) failures.push(cp);
    at = end;
  }
  expect(at).toBe(0x110000);
  expect(failures).toEqual([]);
});

// Characters each table admits next to ones it does not: combining marks (some
// that compose, some that reorder), Hangul jamo and syllables, CR LF, emoji ZWJ
// sequences, flags, skin tones, variation selectors, Indic conjuncts, Khmer,
// characters outside the BMP, CJK compatibility ideographs, a lone surrogate.
const PIECES = [
  "a", "Z", " ", "~", "\n", "\r", "\r\n", "\t", "\u007f", "©", "é", "é", "́", "̖", "ͅ",
  "e" + "́".repeat(12), "東", "か", "゙", "が", "가", "각", "ᄀ", "ᅡ", "ᆨ", "豈",
  "\u{1f468}‍\u{1f469}‍\u{1f467}", "‍", "\u{1f600}", "\u{1f3fd}", "\u{1f1ef}\u{1f1f5}", "\u{1f1ef}",
  "✂️", "️", "ស្ត្រី", "្", "क्ष", "्", "क", "؀", "ः", "\u{20000}", "\u{2f800}",
  "\u{e0100}", "\u{1d15e}", "\ud800",
];
const text = (maxLength: number) => fc.array(fc.constantFrom(...PIECES), { maxLength }).map((a) => a.join(""));
const short = text(24);
const any = fc.oneof(short, text(400));

it("normalizes as WebAssembly does", () => {
  fc.assert(
    fc.property(any, (s) => {
      expect(fast.normalize(s, "NFC")).toBe(slow.normalize(s, "NFC"));
      expect(fast.normalize(s, "NFD")).toBe(slow.normalize(s, "NFD"));
    }),
    { numRuns: 3000 },
  );
});

it("counts and segments as WebAssembly does, including from a prefix", () => {
  fc.assert(
    fc.property(any, fc.nat(300), (s, k) => {
      const some = Array.from(fast.graphemeBoundaries(s, k));
      const someSlow = Array.from(slowSome.graphemeBoundaries(s, k));
      const all = Array.from(slow.graphemeBoundaries(s));
      expect(Array.from(fast.graphemeBoundaries(s))).toEqual(all);
      expect(fast.graphemeCount(s)).toBe(all.length - 1);
      expect(some).toEqual(all.slice(0, k + 1));
      expect(someSlow).toEqual(all.slice(0, k + 1));
    }),
    { numRuns: 3000 },
  );
});

// A prefix is 64 code units for the first few clusters. These put its end at
// every offset of long clusters, where a wrong cut changes the answer.
it("does not take a prefix's end for a boundary", () => {
  for (let k = 1; k <= 6; k++) {
    // The first k - 1 clusters are one unit each; cluster k - 1 runs past unit 64.
    const s = "a".repeat(k - 1) + "e" + "\u0301".repeat(80) + "z".repeat(300);
    const all = Array.from(slow.graphemeBoundaries(s));
    expect(Array.from(slowSome.graphemeBoundaries(s, k))).toEqual(all.slice(0, k + 1));
    expect(Array.from(fast.graphemeBoundaries(s, k))).toEqual(all.slice(0, k + 1));
  }
});

it("never cuts a prefix inside a surrogate pair", () => {
  // Emoji ZWJ sequences (11 units, mostly surrogate pairs; no boundary inside),
  // shifted so the end of the prefix lands on each of their units.
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  for (let pad = 0; pad < 12; pad++) {
    const s = "\u0301" + "y".repeat(pad) + family.repeat(30) + "a".repeat(400);
    const all = Array.from(slow.graphemeBoundaries(s));
    for (let k = 1; k <= 8; k++) {
      const fresh = Array.from(slowSome.graphemeBoundaries(s + String(k), k));
      expect(fresh).toEqual(all.slice(0, k + 1));
    }
  }
});

it("Text.slice, Text.at and Text.length index clusters as Array.prototype.slice and at do", () => {
  const index = fc.oneof(fc.integer({ min: -30, max: 30 }), fc.double({ min: -30, max: 30 }), fc.constantFrom(NaN, Infinity, -Infinity, 1e9));
  fc.assert(
    fc.property(any, index, fc.option(index, { nil: undefined }), (s, a, e) => {
      const t = Text.nfc(s);
      const plain: string = t; // Text hides UTF-16 indexing from the type checker
      const b = Array.from(slow.graphemeBoundaries(plain));
      const clusters = b.slice(1).map((end, i) => plain.slice(b[i], end));
      expect(Text.length(t)).toBe(clusters.length);
      expect(Text.graphemes(t)).toEqual(clusters);
      expect(Text.slice(t, a, e)).toBe(clusters.slice(a, e).join(""));
      expect(Text.at(t, a)).toBe(clusters.at(a));
    }),
    { numRuns: 3000 },
  );
});
