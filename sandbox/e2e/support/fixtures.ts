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
    await this.navigate(path);
    await this.live();
  }

  /**
   * Loads a page, trying a second time if the first navigation gets no page within
   * 20 s. In CI, WebKit has once left the very first request of a page (the HTML,
   * served by the same backend that had just answered an admin call) without a
   * response for the whole test. That is the browser or the runner, not the app:
   * what a test checks starts once the page is there.
   */
  async navigate(path = "/"): Promise<void> {
    try {
      await this.page.goto(path, { timeout: 20_000 });
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "TimeoutError") throw e;
      base.info().annotations.push({ type: "navigation retried", description: `${path}: ${e.message.split("\n")[0]}` });
      await this.page.goto(path, { timeout: 20_000 });
    }
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
    // The app notifies the UI once per frame, so the screen can trail the state
    // it was just compared on by a frame or more on a slow machine: poll it too.
    const rows = (selector: string, keys: string[]) =>
      this.page.$$eval(selector, (els, keys) => els.map((e) => keys.map((k) => (e as HTMLElement).dataset[k])), keys);
    await expect
      .poll(() => rows("[data-testid=instrument-row]", ["id", "last", "version"]), { timeout: 5_000 })
      .toEqual(expected.instruments.map(([id, last, version]) => [id, last, version]));
    await expect
      .poll(() => rows("[data-testid=order-row]", ["id", "status", "filled", "version"]), { timeout: 5_000 })
      .toEqual(expected.orders.slice(0, 200).map(([id, status, filled, version]) => [id, status, filled, version]));
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
