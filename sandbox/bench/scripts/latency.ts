// From the server sending a trade to the DOM showing it, for the SeamScript app
// and its TypeScript + Zod twin, at several message rates.
//
// An init script records, inside the page, when each WebSocket message arrived
// (a listener added before the app's own, on a WebSocket subclass) and when
// each price row's data-version changed (a MutationObserver, which runs right
// after React commits). The row's version is the trade's sequence number, which
// joins the two. Both times come from the page's own clock:
//   receive → DOM: decode + apply + React render, the part the language affects.
//   send → DOM:    the same plus the network, using the server's send stamp (t)
//                  and performance.timeOrigin, so it also contains any offset
//                  between the two processes' clocks.
import { Backend, type BrowserName, log, type Summary, startBackend, summary, withBrowser } from "./lib.ts";

const RECORDER = `(() => {
  const recv = [];
  const shown = [];
  const Base = window.WebSocket;
  window.WebSocket = class extends Base {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (e) => { recv.push(performance.now(), e.data); });
    }
  };
  const start = () => new MutationObserver((records) => {
    const now = performance.now();
    for (const r of records) {
      const el = r.target;
      if (el.dataset && el.dataset.testid === "instrument-row") shown.push(now, el.dataset.version);
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-version"] });
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  window.__lat = { recv, shown };
})();`;

export type RenderMode = "frame" | "each";

export interface LatencyRun {
  app: string;
  browser: string;
  rate: number;
  /** "frame": the apps as built (views updated once per animation frame); "each": a render per message. */
  mode: RenderMode;
  isolated: boolean;
  /** Trades received in the window. */
  received: number;
  /** Of those, how many reached the DOM. */
  shown: number;
  receiveToDom: Summary;
  sendToDom: Summary;
  /** The app's own timing of one message: decode + apply (no rendering), over its last 1024 messages. */
  handler: { p50: number; p99: number };
}

const APPS = [
  { app: "SeamScript", path: "/" },
  { app: "TypeScript + Zod", path: "/ts/" },
];

async function measure(
  backend: Backend,
  browserName: BrowserName,
  url: string,
  app: (typeof APPS)[number],
  rate: number,
  mode: RenderMode,
  ms: { warmup: number; window: number },
): Promise<LatencyRun> {
  await backend.reset({ seed: 1, instruments: 40, orders: 30 });
  await backend.driver({ ticksPerSecond: rate, externalOrdersPerSecond: 0, heartbeatMs: 1000, paused: false, stamp: true });
  return withBrowser(browserName, async (b) => {
    const page = await b.newPage();
    await page.addInitScript(RECORDER);
    await page.goto(`${url}${app.path}?render=${mode}`);
    await page.waitForSelector("[data-testid=status][data-status=live]", { timeout: 30_000 });
    await page.waitForTimeout(ms.warmup);
    await page.evaluate(() => {
      const l = (window as unknown as { __lat: { recv: unknown[]; shown: unknown[] } }).__lat;
      l.recv.length = 0;
      l.shown.length = 0;
    });
    await page.waitForTimeout(ms.window);
    const data = await page.evaluate(() => {
      const l = (window as unknown as { __lat: { recv: (number | string)[]; shown: (number | string)[] } }).__lat;
      const feed = (window as unknown as { __feed: { frameTimes(): { p50: number; p99: number } } }).__feed;
      return {
        recv: l.recv.slice(),
        shown: l.shown.slice(),
        origin: performance.timeOrigin,
        isolated: crossOriginIsolated,
        handler: feed.frameTimes(),
      };
    });
    const trades = new Map<string, { at: number; t: number }>();
    for (let i = 0; i < data.recv.length; i += 2) {
      const raw = data.recv[i + 1];
      if (typeof raw !== "string") continue;
      const m = JSON.parse(raw) as { type: string; seq: string | number; t?: number };
      if (m.type === "tick" && typeof m.t === "number") trades.set(String(m.seq), { at: data.recv[i] as number, t: m.t });
    }
    const receiveToDom: number[] = [];
    const sendToDom: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < data.shown.length; i += 2) {
      const version = data.shown[i + 1] as string;
      const trade = trades.get(version);
      if (trade === undefined || seen.has(version)) continue;
      seen.add(version);
      const at = data.shown[i] as number;
      receiveToDom.push(at - trade.at);
      sendToDom.push(data.origin + at - trade.t);
    }
    return {
      app: app.app,
      browser: `${browserName} ${b.version()}`,
      rate,
      mode,
      isolated: data.isolated,
      received: trades.size,
      shown: seen.size,
      receiveToDom: summary(receiveToDom),
      sendToDom: summary(sendToDom),
      handler: { p50: data.handler.p50, p99: data.handler.p99 },
    };
  });
}

export async function latency(options: {
  browsers: BrowserName[];
  rates: Record<RenderMode, number[]>;
  warmupMs: number;
  windowMs: number;
  rounds: number;
}): Promise<LatencyRun[]> {
  const server = await startBackend();
  const backend = new Backend(server.url);
  const out: LatencyRun[] = [];
  try {
    for (const browser of options.browsers) {
      for (const mode of ["frame", "each"] as const) {
        for (const rate of options.rates[mode]) {
          // Alternate the apps, a few rounds each, so drift does not favour one.
          for (let r = 0; r < options.rounds; r++) {
            for (const app of r % 2 === 0 ? APPS : [...APPS].reverse()) {
              log(`latency: ${browser} ${mode} ${app.app} ${rate}/s round ${r + 1}`);
              out.push(await measure(backend, browser, server.url, app, rate, mode, { warmup: options.warmupMs, window: options.windowMs }));
            }
          }
        }
      }
    }
  } finally {
    await server.stop();
  }
  return out;
}
