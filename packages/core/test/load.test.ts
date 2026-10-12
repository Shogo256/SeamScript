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

  it("keeps a leading U+FEFF, which TextDecoder would drop as a BOM by default", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    expect(runtime.Text.nfc("\uFEFFa")).toBe("\uFEFFa");
    expect(runtime.Text.nfd("\uFEFF")).toBe("\uFEFF");
  });

  it("handles the empty string", async () => {
    const { runtime } = await fresh();
    await import("../js/index.js");
    expect(runtime.Text.nfc("")).toBe("");
    expect(runtime.Text.length(runtime.Text.nfd(""))).toBe(0);
  });
});
