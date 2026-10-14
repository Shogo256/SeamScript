// Realtime synchronization under network faults. Each scenario runs the market
// with a fault switched on, then stops the market, removes the fault, and
// requires the app to end up equal to the server, with nothing on screen ever
// going back to an older value and no uncaught error in the page.
import type { FaultsPatch } from "../support/backend";
import { type Counters, expect, test } from "../support/fixtures";

interface Scenario {
  name: string;
  faults: FaultsPatch;
  /** How long the market runs with the fault. */
  ms: number;
  /** What the app must have noticed (minimums of its counters). */
  noticed?: Partial<Counters>;
  /** Kinds of problem the app must have reported. */
  reported?: string[];
  /** The app must not report any problem (equivalent spellings are not problems). */
  quiet?: boolean;
}

const scenarios: Scenario[] = [
  { name: "No faults", faults: {}, ms: 2000, quiet: true },
  {
    name: "Delay and jitter (WS 80±60 ms, HTTP 50±100 ms)",
    faults: { ws: { latencyMs: 80, jitterMs: 60 }, http: { latencyMs: 50, jitterMs: 100 } },
    ms: 3000,
    quiet: true,
  },
  { name: "Reordering (windows of 8)", faults: { ws: { reorderWindow: 8 } }, ms: 3000 },
  { name: "Duplicates (30%)", faults: { ws: { duplicateRate: 0.3 } }, ms: 3000, noticed: { duplicates: 1 } },
  { name: "Drops (5%)", faults: { ws: { dropRate: 0.05 } }, ms: 3000, noticed: { gaps: 1, snapshots: 2 } },
  { name: "Broken JSON (5%)", faults: { ws: { corruptRate: 0.05 } }, ms: 3000, noticed: { rejected: 1, gaps: 1 }, reported: ["json"] },
  { name: "Binary frames (5%)", faults: { ws: { binaryRate: 0.05 } }, ms: 3000, noticed: { rejected: 1 }, reported: ["frame"] },
  {
    name: "Schema drift (10%: order ID as a UUID, price as a number)",
    faults: { ws: { driftRate: 0.1 } },
    ms: 3000,
    noticed: { rejected: 1 },
    reported: ["decode"],
  },
  {
    name: "Same value, different spelling (50%: numeric ID, NFD, another UTC offset, trailing zeros)",
    faults: { ws: { variantRate: 0.5 }, http: { variantRate: 0.5 } },
    ms: 3000,
    quiet: true,
  },
  {
    name: "Disconnect and reconnect (with a close frame, every 0.7 s)",
    faults: { ws: { disconnectEveryMs: 700, disconnectMode: "close", refuseMs: 300 } },
    ms: 4000,
    noticed: { disconnects: 3, connects: 4 },
  },
  {
    name: "Disconnect and reconnect (TCP cut only, every 0.7 s)",
    faults: { ws: { disconnectEveryMs: 700, disconnectMode: "terminate", refuseMs: 300 } },
    ms: 4000,
    noticed: { disconnects: 3, connects: 4 },
  },
  {
    name: "Everything at once",
    faults: {
      ws: {
        latencyMs: 30,
        jitterMs: 40,
        reorderWindow: 5,
        duplicateRate: 0.1,
        dropRate: 0.03,
        corruptRate: 0.02,
        binaryRate: 0.01,
        driftRate: 0.02,
        variantRate: 0.3,
        disconnectEveryMs: 2500,
        disconnectMode: "terminate",
        refuseMs: 200,
      },
      http: { latencyMs: 50, jitterMs: 100, errorRate: 0.1, corruptRate: 0.05, variantRate: 0.3 },
    },
    ms: 8000,
    noticed: { rejected: 1, duplicates: 1, disconnects: 2 },
  },
];

test.describe("Real-time sync", () => {
  for (const s of scenarios) {
    test(s.name, async ({ app, backend }) => {
      await app.open();
      await backend.faults(s.faults);
      await app.page.waitForTimeout(s.ms);
      // The faults stay on until each count is reached: how many happen in s.ms
      // depends on how late a loaded machine runs the page's timers (reconnect
      // backoff, fault intervals), not on the app.
      for (const [key, min] of Object.entries(s.noticed ?? {})) {
        await expect.poll(async () => (await app.counters())[key as keyof Counters], { message: `counters.${key}`, timeout: 20_000 }).toBeGreaterThanOrEqual(min);
      }
      await app.expectConverged();
      const kinds = new Set((await app.problems()).map((p) => p.kind));
      for (const kind of s.reported ?? []) expect([...kinds], `reported ${kind}`).toContain(kind);
      if (s.quiet) expect(await app.problems()).toEqual([]);
    });
  }

  test("Server restart (new epoch, seq counts again from 0)", async ({ app, backend }) => {
    await app.open();
    await app.page.waitForTimeout(1000);
    const before = await app.digest();
    await backend.reset({ seed: 99, instruments: 25, orders: 10 });
    await expect.poll(async () => (await app.digest()).epoch).not.toBe(before.epoch);
    const after = await app.expectConverged();
    expect(after.instruments).toHaveLength(25);
    expect((await app.problems()).map((p) => p.kind)).toContain("epoch");
    expect((await app.monitor()).epochs).toHaveLength(2);
  });

  test("Silent connection: once nothing arrives, old values are not shown as live", async ({ app, backend }) => {
    await app.open();
    // Everything sent from now on is held for a minute: the socket stays open but silent.
    await backend.faults({ ws: { latencyMs: 60_000 } });
    const board = app.page.getByTestId("board");
    await expect(board).toHaveAttribute("data-stale", "true", { timeout: 6000 });
    await expect(app.page.getByTestId("stale-banner")).toBeVisible();
    expect(await app.page.getByTestId("status").getAttribute("data-status")).not.toBe("live");
    await app.expectConverged();
    await expect(board).toHaveAttribute("data-stale", "false");
  });

  test("1,000 events per second while snapshots fail for 4 s: catches up once fixed", async ({ app, backend }) => {
    await app.open();
    await backend.driver({ ticksPerSecond: 1000 });
    await backend.faults({ http: { errorRate: 1 } });
    await backend.disconnect("close"); // the reconnect has missed events, so it needs a snapshot
    await app.page.waitForTimeout(4000);
    const meta = await app.page.evaluate(() => ({ status: window.__feed!.meta.status, pending: window.__feed!.meta.pending }));
    expect(meta.status).toBe("syncing");
    expect(meta.pending).toBeGreaterThan(1000); // held for the snapshot, not dropped
    expect((await app.problems()).some((p) => p.source === "snapshot")).toBe(true);
    await app.expectConverged(30_000);
  });

  test("While disconnected the values are marked as old, and it catches up on reconnect", async ({ app, backend }) => {
    await app.open();
    await backend.faults({ ws: { refuseMs: 3000 } });
    await backend.disconnect("terminate");
    await expect(app.page.getByTestId("board")).toHaveAttribute("data-stale", "true", { timeout: 3000 });
    await expect(app.page.getByTestId("feed-status")).toHaveText("offline");
    await app.page.waitForTimeout(1500);
    await app.expectConverged();
  });
});
