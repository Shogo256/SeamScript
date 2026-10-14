import { describe, expect, it, vi } from "vitest";
import { __b, __decode, Text } from "../src/index.js";

const family = "👨‍👩‍👧‍👦"; // one grapheme, 11 code units
const flags = "🇯🇵🇺🇸"; // two graphemes

describe("construction", () => {
  it("normalizes to the requested form", () => {
    expect(Text.nfc("café")).toBe("café");
    expect(Text.nfd("café")).toBe("café");
  });

  it("joins parts and normalizes the whole, since joined NFC pieces may not be NFC", () => {
    expect(Text.nfc("cafe", "́")).toBe("café");
    expect(Text.nfc()).toBe("");
  });

  it("replaces lone surrogates instead of failing", () => {
    expect(Text.nfc("a\uD800b")).toBe("a�b");
  });
});

describe("decode", () => {
  it("normalizes on arrival", () => {
    expect(__decode(__b.text("NFC"), "café")).toEqual({ ok: true, value: "café" });
  });

  it("rejects ill-formed UTF-16 at the boundary", () => {
    expect(__decode(__b.text("NFC"), "a\uDC00")).toMatchObject({
      ok: false,
      error: { expected: "text", actual: "string (lone surrogate)" },
    });
  });

  it("rejects non-strings", () => {
    expect(__decode(__b.text("NFD"), 1)).toMatchObject({ ok: false, error: { actual: "number" } });
  });
});

describe("grapheme operations", () => {
  const t = Text.nfc(`a${family}b${flags}é`);

  it("counts grapheme clusters", () => {
    expect(Text.length(t)).toBe(6);
    expect(Text.length(Text.nfd("é"))).toBe(1);
    expect(Text.length(Text.nfc("a\r\nb"))).toBe(3);
    expect(Text.length(Text.nfc(""))).toBe(0);
    expect(Text.length(Text.nfc("plain ascii"))).toBe(11);
  });

  it("indexes and slices without splitting clusters", () => {
    expect(Text.at(t, 1)).toBe(family);
    expect(Text.at(t, -1)).toBe("é");
    expect(Text.at(t, 6)).toBeUndefined();
    expect(Text.at(t, -7)).toBeUndefined();
    expect(Text.slice(t, 0, 2)).toBe(`a${family}`);
    expect(Text.slice(t, 3, 5)).toBe(flags);
    expect(Text.slice(t, -2)).toBe("🇺🇸é");
    expect(Text.slice(t, 4, 2)).toBe("");
    expect(Text.slice(t)).toBe(t);
  });

  it("keeps the spec's demo bug from happening: slicing an emoji string", () => {
    const memo = Text.nfc(`${family}${family}`);
    const naive = (memo as string).slice(0, 10);
    expect(naive.isWellFormed()).toBe(false); // what plain TS does
    expect(Text.slice(memo, 0, 1)).toBe(family);
  });

  it("splits into graphemes", () => {
    expect(Text.graphemes(t)).toEqual(["a", family, "b", "🇯🇵", "🇺🇸", "é"]);
  });

  it("reports the fallback as non-deterministic", () => {
    expect(Text.deterministic).toBe(false);
    expect(Text.unicodeVersion).toBeNull();
    expect(Text.status).toBe("host");
  });
});

// Core state is module-global, so these tests import a fresh copy of the runtime.
describe("core", () => {
  async function freshRuntime() {
    vi.resetModules();
    return import("../src/index.js");
  }

  it("uses the installed core for normalization and segmentation", async () => {
    const rt = await freshRuntime();
    const core = {
      normalize: vi.fn((s: string, f: "NFC" | "NFD") => s.normalize(f)),
      // Deliberately different from ICU: one grapheme per code point.
      graphemeCount: vi.fn((s: string) => [...s].length),
      graphemeBoundaries: vi.fn((s: string, limit = Infinity) => {
        const out = [0];
        for (const cp of s) {
          if (out.length > limit) break;
          out.push(out[out.length - 1]! + cp.length);
        }
        return out;
      }),
      unicodeVersion: "16.0.0",
    };
    rt.__installCore(core);
    expect(rt.Text.status).toBe("core");
    expect(rt.Text.deterministic).toBe(true);
    expect(rt.Text.unicodeVersion).toBe("16.0.0");
    expect(rt.Text.length(rt.Text.nfc(flags))).toBe(4);
    expect(core.normalize).toHaveBeenCalledWith(flags, "NFC");
  });

  it("throws CoreUnavailableError after the core failed to load, including from decode", async () => {
    const rt = await freshRuntime();
    const cause = new Error("CSP blocked WebAssembly");
    rt.__coreFailed(cause);
    expect(rt.Text.status).toBe("failed");
    expect(() => rt.Text.nfc("x")).toThrow(rt.CoreUnavailableError);
    expect(() => rt.__decode(rt.__b.text("NFC"), "x")).toThrow(rt.CoreUnavailableError);
    try {
      rt.Text.nfc("x");
    } catch (e) {
      expect((e as Error).cause).toBe(cause);
    }
    // Decoders that do not touch Text are unaffected.
    expect(rt.__decode(rt.__b.int64, 1)).toEqual({ ok: true, value: 1n });
    // Printable ASCII needs no segmentation, so it keeps working.
    expect(rt.Text.length("abc" as never)).toBe(3);
  });
});
