import { test as base, expect, type Page } from "@playwright/test";
import { Backend, type ServerProcess, type ServerState, startBackend } from "./backend";
import { monitor } from "./monitor";

export { expect };

export interface Digest {
  epoch: string | null;
  seq: string;
  /** [id, last, version, updatedAt in epoch nanoseconds] */
  instruments: string[][];
  /** [id, status, filled, version, memo], newest first */
  orders: string[][];
}

export interface Counters {
  frames: number;
  applied: number;
  duplicates: number;
  rejected: number;
  gaps: number;
  resyncs: number;
  snapshots: number;
  connects: number;
  disconnects: number;
}

export interface MonitorState {
  violations: { key: string; from: string; to: string; epoch: string | null }[];
  samples: number;
  epochs: string[];
  statuses: Record<string, number>;
}

interface FeedHandle {
  digest(): Digest;
  meta: { status: string; counters: Counters; pending: number };
  problems: readonly { kind: string; source: string; message: string }[];
}

declare global {
  interface Window {
    __feed?: FeedHandle;
    __monitor?: MonitorState;
  }
}

/** What the app's digest must equal once it has caught up with this state. */
export function expectedDigest(s: ServerState): Digest {
  return {
    epoch: s.epoch,
    seq: s.seq,
    instruments: s.instruments.map((i) => [i.id, i.last, i.version, String(BigInt(Date.parse(i.updatedAt)) * 1_000_000n)]),
    orders: [...s.orders].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)).map((o) => [o.id, o.status, o.filled, o.version, o.memo]),
  };
}

export class App {
  readonly page: Page;
  readonly backend: Backend;

  constructor(page: Page, backend: Backend) {
    this.page = page;
    this.backend = backend;
  }

  async open(path = "/"): Promise<void> {
    await this.page.goto(path);
    await this.live();
  }

  async live(timeout = 15_000): Promise<void> {
    await expect(this.page.getByTestId("status")).toHaveAttribute("data-status", "live", { timeout });
  }

  digest(): Promise<Digest> {
    return this.page.evaluate(() => window.__feed!.digest());
  }

  counters(): Promise<Counters> {
    return this.page.evaluate(() => ({ ...window.__feed!.meta.counters }));
  }

  problems(): Promise<{ kind: string; source: string; message: string }[]> {
    return this.page.evaluate(() => window.__feed!.problems.map((p) => ({ kind: p.kind, source: p.source, message: p.message })));
  }

  monitor(): Promise<MonitorState> {
    return this.page.evaluate(() => window.__monitor!);
  }

  /**
   * Stops the market, removes every fault, and waits until the app's state, and
   * then the screen, equal the server's. Also checks nothing on screen ever went
   * back to an older version.
   */
  async expectConverged(timeout = 20_000): Promise<Digest> {
    await this.backend.driver({ paused: true });
    await this.backend.clearFaults();
    const expected = expectedDigest(await this.backend.state());
    await expect.poll(() => this.digest(), { timeout, intervals: [100, 200, 500] }).toEqual(expected);
    await this.live();
    const instruments = await this.page.$$eval("[data-testid=instrument-row]", (rows) =>
      rows.map((r) => [(r as HTMLElement).dataset["id"], (r as HTMLElement).dataset["last"], (r as HTMLElement).dataset["version"]]),
    );
    expect(instruments).toEqual(expected.instruments.map(([id, last, version]) => [id, last, version]));
    const orders = await this.page.$$eval("[data-testid=order-row]", (rows) =>
      rows.map((r) => [(r as HTMLElement).dataset["id"], (r as HTMLElement).dataset["status"], (r as HTMLElement).dataset["filled"], (r as HTMLElement).dataset["version"]]),
    );
    expect(orders).toEqual(expected.orders.slice(0, 200).map(([id, status, filled, version]) => [id, status, filled, version]));
    const m = await this.monitor();
    expect(m.violations, "something on screen went back to an older version").toEqual([]);
    return expected;
  }
}

function seedOf(title: string): number {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) h = Math.imul(h ^ title.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const test = base.extend<{ backend: Backend; app: App }, { server: ServerProcess }>({
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startBackend();
      await use(server);
      await server.stop();
    },
    { scope: "worker" },
  ],
  baseURL: async ({ server }, use) => use(server.url),
  backend: async ({ server }, use, testInfo) => {
    const backend = new Backend(server.url);
    await backend.reset({ seed: seedOf(testInfo.titlePath.join(" / ")), instruments: 40, orders: 30 });
    await backend.driver({ ticksPerSecond: 50, externalOrdersPerSecond: 1, heartbeatMs: 250, paused: false, stamp: false });
    await backend.faults({ csp: "wasm" });
    await use(backend);
  },
  app: async ({ page, backend }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
    await page.addInitScript(monitor);
    await use(new App(page, backend));
    expect(errors, "uncaught errors in the page").toEqual([]);
  },
});
