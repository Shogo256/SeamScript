// SeamScript's side of the benchmarks: decode with the app's own boundaries, and
// Text next to what a browser offers (Intl.Segmenter, String.prototype.normalize).
import { ServerMessage, Snapshot } from "../../app/src/api.seam";
import fixtures from "../fixtures/messages.json";
import type { Case } from "./harness";

export function decodeCases(): Case[] {
  const tick = JSON.parse(fixtures.tick);
  const order = JSON.parse(fixtures.order);
  const snapshot = JSON.parse(fixtures.snapshot);
  return [
    { group: "decode: tick", name: "SeamScript decode", fn: () => decode ServerMessage from tick },
    { group: "decode: order event", name: "SeamScript decode", fn: () => decode ServerMessage from order },
    { group: "decode: snapshot (40 + 1000 orders)", name: "SeamScript decode", fn: () => decode Snapshot from snapshot },
    { group: "parse + decode: tick", name: "SeamScript", fn: () => decode ServerMessage from JSON.parse(fixtures.tick) },
  ];
}

const SAMPLES: Record<string, string> = {
  "ASCII 21": "Order 12345 filled ok",
  "Japanese 20": "東都電機の決算は来週火曜日の午後に発表予定",
  "Emoji (ZWJ, flags, skin tones)": "👨‍👩‍👧🇯🇵🍣👍🏽✂️".repeat(4),
  "Khmer (changed in Unicode 17)": "ស្ត្រី".repeat(10),
  // Accented Latin: the NFD input really changes under NFC.
  "Accented Latin": "Crème brûlée, façade, naïve",
  "Japanese 10 KB": "東都電機の決算は来週火曜日の午後に発表予定。".repeat(160),
};

/** Distinct strings, more than Text's 256-entry boundary cache holds. */
function pool(s: string): string[] {
  return Array.from({ length: 1024 }, (_, i) => `${s}${i}`);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function intlLength(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

function intlSlice(s: string, end: number): string {
  let out = "";
  let n = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (n++ === end) break;
    out += segment;
  }
  return out;
}

export function textCases(): Case[] {
  const out: Case[] = [];
  for (const [label, s] of Object.entries(SAMPLES)) {
    const plain = pool(s);
    const texts = plain.map((x) => Text.nfc(x));
    const nfd = plain.map((x) => x.normalize("NFD"));
    const one = Text.nfc(s);
    let i = 0;
    let j = 0;
    let k = 0;
    let l = 0;
    let m = 0;
    let n = 0;
    out.push(
      { group: `length: ${label}`, name: "Text.length (same string: cached)", fn: () => Text.length(one) },
      { group: `length: ${label}`, name: "Text.length (1024 strings: uncached)", fn: () => Text.length(texts[i++ & 1023]!) },
      { group: `length: ${label}`, name: "Intl.Segmenter count", fn: () => intlLength(plain[j++ & 1023]!) },
      { group: `slice(0, 10): ${label}`, name: "Text.slice (uncached)", fn: () => Text.slice(texts[k++ & 1023]!, 0, 10) },
      { group: `slice(0, 10): ${label}`, name: "Intl.Segmenter slice", fn: () => intlSlice(plain[l++ & 1023]!, 10) },
      { group: `NFC: ${label}`, name: "Text.nfc", fn: () => Text.nfc(nfd[m++ & 1023]!) },
      { group: `NFC: ${label}`, name: "String.prototype.normalize", fn: () => nfd[n++ & 1023]!.normalize("NFC") },
    );
  }
  return out;
}
