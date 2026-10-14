// Placing orders: encode on the way out, the server's checks on the way in, and
// retries that never create a second order.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

// "ស្ត្រី" (Khmer, "woman") is one grapheme in Unicode 17.0 and three in 16.0
// (GraphemeBreakTest.txt): a memo where the version decides the count.
const KHMER = "ស្ត្រី";

async function fillOrder(page: Page, o: { row?: number; quantity: string; memo: string }) {
  await page.getByTestId("instrument-row").nth(o.row ?? 3).click();
  await page.getByTestId("quantity").fill(o.quantity);
  await page.getByTestId("memo").fill(o.memo);
}

async function acceptedId(page: Page): Promise<string> {
  const outcome = page.getByTestId("order-outcome");
  await expect(outcome).toHaveAttribute("data-ok", "true");
  return /Order (\d+) accepted/.exec((await outcome.textContent())!)![1]!;
}

test.describe("Placing orders", () => {
  test("Int64, Decimal and Text round-trip exactly and reach the table through the stream", async ({ app, backend, page }, testInfo) => {
    await app.open();
    const memo = KHMER.repeat(14);
    await fillOrder(page, { quantity: "300", memo });
    // Text (WASM core, Unicode 17) counts 14; the server, with the same core, agrees.
    await expect(page.getByTestId("memo-count")).toHaveAttribute("data-length", "14");
    const intl = await page.evaluate((s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length, memo);
    testInfo.annotations.push({ type: "Intl.Segmenter in this browser", description: `${intl} graphemes for ${KHMER} × 14 (Unicode 17: 14, 16: 42)` });
    await page.getByTestId("submit").click();
    const id = await acceptedId(page);
    expect(BigInt(id)).toBeGreaterThan(2n ** 53n);
    const order = (await backend.state()).orders.find((o) => o.id === id)!;
    expect(order).toMatchObject({ quantity: "300", memo });
    await expect(page.locator(`[data-testid=order-row][data-id="${id}"]`)).toBeVisible();
    await app.expectConverged();
  });

  test("A 500 after the order was created is retried with the same clientOrderId, leaving one order", async ({ app, backend, page }) => {
    await app.open();
    await backend.faults({ http: { commitThenFailRate: 1 } });
    await fillOrder(page, { quantity: "100", memo: "retry test" });
    await page.getByTestId("submit").click();
    const id = await acceptedId(page);
    const stats = await backend.stats();
    expect(stats.http.committedThenFailed).toBe(1);
    expect(stats.http.requests["POST /api/orders"]).toBe(2);
    const mine = (await backend.state()).orders.filter((o) => o.memo === "retry test");
    expect(mine.map((o) => o.id)).toEqual([id]);
    await app.expectConverged();
  });

  test("An order the server rejects shows the reason and the field", async ({ app, page }) => {
    await app.open();
    await fillOrder(page, { quantity: "2000000000", memo: "" });
    await page.getByTestId("submit").click();
    const outcome = page.getByTestId("order-outcome");
    await expect(outcome).toHaveAttribute("data-ok", "false");
    await expect(outcome).toContainText("quantity");
  });

  test("A one-character memo that is too long (300 combining marks) is stopped by its byte count", async ({ app, page }) => {
    await app.open();
    await fillOrder(page, { quantity: "100", memo: `a${"́".repeat(300)}` });
    const count = page.getByTestId("memo-count");
    await expect(count).toHaveAttribute("data-length", "1");
    expect(Number(await count.getAttribute("data-bytes"))).toBeGreaterThan(256);
    await expect(page.getByTestId("invalid")).toContainText("bytes");
    await expect(page.getByTestId("submit")).toBeDisabled();
  });

  test("Typing a single 100,000-code-unit grapheme doesn't freeze the page", async ({ app, page }, testInfo) => {
    await app.open();
    const start = Date.now();
    await page.getByTestId("memo").fill(`a${"́".repeat(100_000)}`);
    await expect(page.getByTestId("memo-count")).toHaveAttribute("data-length", "1");
    const ms = Date.now() - start;
    testInfo.annotations.push({ type: "input to counter", description: `${ms} ms` });
    expect(ms).toBeLessThan(3000);
  });
});
