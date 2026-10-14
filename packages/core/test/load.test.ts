import { describe, expect, it, vi } from "vitest";

// Each test gets a runtime without a core (vitest.config.ts inlines it).
async function fresh() {
  vi.resetModules();
  const runtime = await import("@seamscript/runtime");
  const load = await import("../js/load.js");
  return { runtime, load };
}

describe("loading", () => {
  it("importing the package installs the core before importers run", async () => {
    const { runtime } = await fresh();
    expect(runtime.Text.deterministic).toBe(false);
    await import("../js/index.js");
    expect(runtime.Text.deterministic).toBe(true);
  });

  it("records a failed load instead of rejecting, so Text throws CoreUnavailableError", async () => {
    const { runtime, load } = await fresh();
    await expect(load.install(new Uint8Array([0, 97, 115, 109, 9, 9]))).resolves.toBeUndefined();
    expect(runtime.Text.status).toBe("failed");
    expect(() => runtime.Text.nfc("x")).toThrow(runtime.CoreUnavailableError);
    // Decoding data without Text still works.
    expect(runtime.__decode(runtime.__b.int64, 1)).toEqual({ ok: true, value: 1n });
  });
});

describe("the ABI", () => {
  it("handles inputs larger than the module's initial memory", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    const big = "é👨‍👩‍👧‍👦".repeat(200_000); // ~2.8 MB of UTF-8
    const nfc = runtime.Text.nfc(big);
    expect(nfc.length).toBe(200_000 * 12);
    expect(runtime.Text.length(nfc)).toBe(400_000);
  });

  it("returns results larger than the module's initial memory", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    // Decomposed input, so the work and the result are WebAssembly's, not a shortcut's.
    const nfd = "e\u0301\u{1f44d}\u{1f3fd}".repeat(300_000);
    const nfc = runtime.Text.nfc(nfd);
    expect(nfc).toBe("\u00e9\u{1f44d}\u{1f3fd}".repeat(300_000));
    expect(runtime.Text.nfd(nfc)).toBe(nfd);
    expect(runtime.Text.length(nfc)).toBe(600_000);
    expect(runtime.Text.graphemes(nfc).length).toBe(600_000);
    expect(runtime.Text.slice(nfc, -2)).toBe("\u00e9\u{1f44d}\u{1f3fd}");
  });

  it("keeps a leading U+FEFF, which TextDecoder would drop as a BOM by default", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    expect(runtime.Text.nfc("\uFEFFa")).toBe("\uFEFFa");
    expect(runtime.Text.nfd("\uFEFF")).toBe("\uFEFF");
  });

  it("replaces lone surrogates when constructing, as a UTF-8 based backend would", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    expect(runtime.Text.nfc("a\ud800b")).toBe("a\ufffdb");
    expect(runtime.Text.nfd("\udc00")).toBe("\ufffd");
    // Even where nothing else would change, so the quick check alone is not enough.
    expect(runtime.Text.nfc("\u{1f600}\ud83d")).toBe("\u{1f600}\ufffd");
    expect(runtime.__decode(runtime.__b.text("NFC"), "a\ud800").ok).toBe(false);
  });

  it("handles the empty string", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    expect(runtime.Text.nfc("")).toBe("");
    expect(runtime.Text.length(runtime.Text.nfd(""))).toBe(0);
  });
});
