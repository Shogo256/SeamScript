// The WASM core in real browsers: it loads, it passes Unicode's own test data,
// and when a CSP forbids it the app stops instead of quietly using the browser's ICU.
import { expect, test } from "../support/fixtures";

interface Report {
  unicode: string | null;
  deterministic: boolean;
  grapheme: { total: number; text: string[]; intl: string[] };
  normalization: { total: number; text: string[]; host: string[] };
}

test.describe("WASM core", () => {
  test("The production build runs on the WASM core (Unicode 17.0.0)", async ({ app, page }) => {
    await app.open();
    await expect(page.getByTestId("status")).toHaveAttribute("data-core", "17.0.0");
  });

  test("Passes all of the official Unicode 17.0.0 test data", async ({ page, backend }, testInfo) => {
    void backend;
    await page.goto("/conformance.html");
    await page.waitForFunction(() => (window as { __conformance?: unknown }).__conformance !== undefined, null, { timeout: 60_000 });
    const r = await page.evaluate(() => (window as unknown as { __conformance: Report | { error: string } }).__conformance);
    if ("error" in r) throw new Error(r.error);
    expect(r.deterministic).toBe(true);
    expect(r.unicode).toBe("17.0.0");
    expect(r.grapheme.total).toBe(766);
    expect(r.grapheme.text).toEqual([]);
    expect(r.normalization.total).toBe(20_034);
    expect(r.normalization.text).toEqual([]);
    // What the browser's own ICU does with the same data, for the record.
    const own = `Intl.Segmenter ${r.grapheme.total - r.grapheme.intl.length}/${r.grapheme.total}, normalize ${r.normalization.total - r.normalization.host.length}/${r.normalization.total}`;
    testInfo.annotations.push({ type: "this browser's ICU", description: own });
    await testInfo.attach("conformance.json", { body: JSON.stringify(r, null, 2), contentType: "application/json" });
  });

  test("If the CSP forbids WASM, the app stops instead of falling back to the browser's ICU", async ({ page, backend }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await backend.faults({ csp: "strict" });
    await page.goto("/");
    await expect(page.getByTestId("fatal")).toBeVisible();
    await expect(page.getByTestId("fatal")).toContainText("wasm-unsafe-eval");
    await expect(page.getByTestId("board")).toHaveCount(0);
    await page.waitForTimeout(500);
    const stats = await backend.stats();
    expect(stats.http.requests["GET /api/snapshot"] ?? 0, "the feed never started").toBe(0);
    expect(errors).toEqual([]);
  });

  test("A build without the core (like development) runs on the browser's ICU and says so", async ({ app, page }) => {
    await app.open("/no-core/");
    await expect(page.getByTestId("status")).toHaveAttribute("data-core", "host");
    await expect(page.getByTestId("core")).toContainText("browser ICU");
  });
});
