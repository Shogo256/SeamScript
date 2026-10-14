// Large and malformed-in-size payloads.
import { expect, test } from "../support/fixtures";

test.describe("Large data", () => {
  test("A snapshot with 20,000 orders", async ({ app, backend, page }, testInfo) => {
    await backend.driver({ externalOrdersPerSecond: 0 });
    await backend.reset({ seed: 7, instruments: 40, orders: 20_000 });
    const start = Date.now();
    await app.open();
    const ms = Date.now() - start;
    testInfo.annotations.push({ type: "open to live", description: `${ms} ms` });
    await expect(page.getByTestId("order-count")).toHaveText("20000");
    await expect(page.getByTestId("order-row")).toHaveCount(200);
    await app.expectConverged(30_000);
  });

  test("Frames carrying a 1 MB extra field (20%)", async ({ app, backend }) => {
    await app.open();
    await backend.faults({ ws: { padRate: 0.2, padBytes: 1_000_000 } });
    await app.page.waitForTimeout(3000);
    expect(await app.problems()).toEqual([]);
    await app.expectConverged();
  });

  test("100,000 levels of nesting in an HTTP response: reported without crashing, caught up once fixed", async ({ app, backend, page }, testInfo) => {
    await backend.faults({ http: { deepNesting: 100_000 } });
    await page.goto("/");
    // Either the browser's JSON parser copes (the field is ignored by decode) or it
    // throws, which the app reports as a problem and retries. Both are fine; a crash is not.
    await expect
      .poll(async () => {
        const status = await page.getByTestId("status").getAttribute("data-status");
        const problems = await app.problems();
        return status === "live" || problems.some((p) => p.source === "snapshot");
      }, { timeout: 15_000 })
      .toBe(true);
    const problems = await app.problems();
    testInfo.annotations.push({ type: "deep JSON", description: problems.length === 0 ? "parsed" : problems[0]!.message });
    await app.expectConverged();
  });
});
