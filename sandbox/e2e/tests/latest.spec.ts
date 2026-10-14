// `latest`: of overlapping requests, only the newest one's answer reaches the
// screen, and the older ones are aborted on the network.
import { expect, test } from "../support/fixtures";

test.describe("latest", () => {
  test("Search: a slow answer to an earlier query doesn't overwrite the later query's results", async ({ app, backend, page }) => {
    await app.open();
    // The first query answers last: "ガ" after 1.2 s, "ガイ" after 0.8 s, "ガイア" at once.
    await backend.faults({ http: { searchDelays: [1200, 800, 0] } });
    await page.getByTestId("search-input").pressSequentially("ガイア", { delay: 60 });
    const results = page.getByTestId("search-results");
    await expect(results).toHaveAttribute("data-query", "ガイア");
    await expect(results.getByRole("button")).toHaveText(["1322 ガイア通信"]);
    // Long enough for both older answers to have arrived, had they not been cancelled.
    await page.waitForTimeout(1600);
    await expect(results).toHaveAttribute("data-query", "ガイア");
    await expect(page.getByTestId("search-input")).toHaveValue("ガイア");
    const stats = await backend.stats();
    expect(stats.http.aborted["GET /api/instruments"], "older requests aborted on the network").toBe(2);
  });

  test("Search: NFD input matches the NFC instrument name (Text.nfc)", async ({ app, page }) => {
    await app.open();
    const nfd = "ガイア".normalize("NFD");
    expect(nfd).not.toBe("ガイア");
    await page.getByTestId("search-input").fill(nfd);
    const results = page.getByTestId("search-results");
    await expect(results).toHaveAttribute("data-query", "ガイア");
    await expect(results.getByRole("button")).toHaveText(["1322 ガイア通信"]);
  });

  test("Order details: a slow answer for a previously selected order is not shown", async ({ app, backend, page }) => {
    await app.open();
    await backend.driver({ paused: true }); // no fills, so the panel fetches exactly once per click
    // Events sent just before the pause are still arriving; wait for them, so no
    // new order is rendered on top while the rows are read.
    const { seq } = await backend.stats();
    await expect.poll(async () => (await app.digest()).seq).toBe(seq);
    const [first, second] = (await page.getByTestId("order-row").evaluateAll((rs) => rs.slice(0, 2).map((r) => (r as HTMLElement).dataset["id"]!))) as [string, string];
    const row = (id: string) => page.locator(`[data-testid=order-row][data-id="${id}"]`);
    await backend.faults({ http: { detailDelays: [1500, 0] } });
    await row(first).click();
    await row(second).click();
    const panel = page.getByTestId("order-detail");
    await expect(panel).toHaveAttribute("data-id", second);
    await expect(panel).toHaveAttribute("data-loaded-id", second);
    await page.waitForTimeout(2000);
    await expect(panel).toHaveAttribute("data-loaded-id", second);
    expect(first).not.toBe(second);
    const stats = await backend.stats();
    expect(stats.http.aborted["GET /api/orders/:id"]).toBe(1);
  });
});
