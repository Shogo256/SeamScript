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

describe("deferred loading", () => {
  it("does not hold up importers; Text waits for Text.ready", async () => {
    const { runtime } = await fresh();
    await import("../js/deferred.js");
    // The importer runs before the core is ready.
    expect(runtime.Text.status).toBe("loading");
    expect(() => runtime.Text.nfc("é")).toThrow(runtime.CoreUnavailableError);
    try {
      runtime.Text.nfc("é");
    } catch (e) {
      expect((e as InstanceType<typeof runtime.CoreUnavailableError>).loading).toBe(true);
      expect((e as Error).message).toMatch(/await Text\.ready/);
    }
    // Printable ASCII needs no Unicode data, so it works meanwhile.
    expect(runtime.Text.length("abc" as never)).toBe(3);
    await runtime.Text.ready;
    expect(runtime.Text.status).toBe("core");
    expect(runtime.Text.nfc("e\u0301")).toBe("\u00e9");
    await expect(runtime.Text.ready).resolves.toBeUndefined();
  });

  it("settles Text.ready on a failed load too, and reports it", async () => {
    const { runtime, load } = await fresh();
    runtime.__coreLoading(load.install(new Uint8Array([0, 97, 115, 109, 9, 9])));
    expect(runtime.Text.status).toBe("loading");
    await runtime.Text.ready;
    expect(runtime.Text.status).toBe("failed");
    expect(() => runtime.Text.nfc("é")).toThrow(/could not be loaded/);
  });

  it("is ready at once when nothing is loading", async () => {
    const { runtime } = await fresh();
    await runtime.Text.ready;
    expect(runtime.Text.status).toBe("host");
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
    // A long result is read back by TextDecoder rather than String.fromCharCode.
    const long = "e\u0301".repeat(1200);
    expect(runtime.Text.nfc(`\uFEFF${long}`)).toBe(`\uFEFF${"\u00e9".repeat(1200)}`);
    expect(runtime.Text.nfd(`\uFEFF${"\u00e9".repeat(1200)}`)).toBe(`\uFEFF${long}`);
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
