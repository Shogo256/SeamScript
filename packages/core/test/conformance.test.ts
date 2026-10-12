// Unicode's own conformance data for the pinned version, run through Text with
// the WASM core installed, and through the core directly. Agreement with
// Intl.Segmenter / String.prototype.normalize is deliberately not required:
// the host's ICU may implement another Unicode version.
import { readFileSync } from "node:fs";
import { Text, type TextCore } from "@seamscript/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { type CoreExports, createCore } from "../js/core.js";
import { decodeBase64, install } from "../js/load.js";
import { WASM_BASE64 } from "../js/wasm.js";

const VERSION = "17.0.0";
const data = (file: string) =>
  readFileSync(new URL(`../.ucd/${VERSION}/${file}`, import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line !== "");
const fromHex = (hex: string) => String.fromCodePoint(...hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));

let core: TextCore;
beforeAll(async () => {
  const bytes = decodeBase64(WASM_BASE64);
  const { instance } = await WebAssembly.instantiate(bytes);
  core = createCore(instance.exports as unknown as CoreExports);
  await install(bytes);
});

it(`implements Unicode ${VERSION} and is installed into Text`, () => {
  expect(core.unicodeVersion).toBe(VERSION);
  expect(Text.unicodeVersion).toBe(VERSION);
  expect(Text.deterministic).toBe(true);
});

describe("GraphemeBreakTest.txt", () => {
  // "÷ 0D ÷ 0308 × 0D ÷": code points with ÷ (boundary) or × (none) between them.
  const cases = data("GraphemeBreakTest.txt").map((line) => {
    let s = "";
    let current = "";
    const boundaries = [0];
    const clusters: string[] = [];
    for (const token of line.split(/\s+/).slice(1)) {
      if (token === "÷") {
        boundaries.push(s.length);
        clusters.push(current);
        current = "";
      } else if (token !== "×") {
        const c = String.fromCodePoint(parseInt(token, 16));
        s += c;
        current += c;
      }
    }
    return { line, s, boundaries, clusters };
  });

  it("has every case of the file", () => {
    expect(cases.length).toBe(766);
  });

  it("core: every boundary", () => {
    const failures = cases.filter((c) => JSON.stringify(Array.from(core.graphemeBoundaries(c.s))) !== JSON.stringify(c.boundaries));
    expect(failures.map((c) => c.line)).toEqual([]);
  });

  it("Text: every cluster", () => {
    // The strings are not normalized; Text's segmentation does not depend on that.
    const failures = cases.filter((c) => JSON.stringify(Text.graphemes(c.s as Text<"NFC">)) !== JSON.stringify(c.clusters));
    expect(failures.map((c) => c.line)).toEqual([]);
  });
});

describe("NormalizationTest.txt", () => {
  const parts = new Map<string, string[][]>();
  let part = "";
  for (const line of data("NormalizationTest.txt")) {
    if (line.startsWith("@")) {
      part = line;
      parts.set(part, []);
    } else {
      parts.get(part)!.push(line.split(";").slice(0, 5).map(fromHex));
    }
  }

  it("has every part of the file", () => {
    expect([...parts.keys()]).toEqual(["@Part0", "@Part1", "@Part2", "@Part3", "@Part4", "@Part5"]);
    expect([...parts.values()].reduce((n, rows) => n + rows.length, 0)).toBe(20_034);
  });

  // The file's conformance conditions for the two forms Text supports:
  //   c2 == NFC(c1) == NFC(c2) == NFC(c3),  c4 == NFC(c4) == NFC(c5)
  //   c3 == NFD(c1) == NFD(c2) == NFD(c3),  c5 == NFD(c4) == NFD(c5)
  it("Text.nfc and Text.nfd meet every condition", () => {
    const failures: string[] = [];
    for (const [name, rows] of parts) {
      for (const [c1, c2, c3, c4, c5] of rows as [string, string, string, string, string][]) {
        const nfc = [c1, c2, c3].every((x) => Text.nfc(x) === c2) && [c4, c5].every((x) => Text.nfc(x) === c4);
        const nfd = [c1, c2, c3].every((x) => Text.nfd(x) === c3) && [c4, c5].every((x) => Text.nfd(x) === c5);
        if (!nfc || !nfd) failures.push(`${name} ${JSON.stringify(c1)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("leaves every code point not listed in Part 1 unchanged", () => {
    const listed = new Set(parts.get("@Part1")!.map(([c1]) => c1!.codePointAt(0)));
    const failures: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp === 0xd800) cp = 0xe000; // surrogates are not characters
      if (listed.has(cp)) continue;
      const x = String.fromCodePoint(cp);
      if (Text.nfc(x) !== x || Text.nfd(x) !== x) failures.push(cp);
    }
    expect(failures).toEqual([]);
  });
});
