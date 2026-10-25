// The pseudo backend: the market over HTTP and WebSocket, an admin API that
// switches faults and reads the authoritative state, and static hosting for the
// built apps (so a test runs the production bundle against the same origin).
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Channel, type ChannelStats, emptyStats } from "./channel.ts";
import { type Faults, noFaults, patchFaults } from "./faults.ts";
import { Market, type MarketEvent, type NewOrder, PRICE_SCALE } from "./market.ts";
import { chance, createRng, int } from "./rng.ts";
import { eventJson, heartbeatJson, helloJson, instrumentJson, orderDetailJson, orderJson, PLAIN, snapshotJson, type Style } from "./wire.ts";

export interface MarketConfig {
  seed: number;
  instruments: number;
  orders: number;
}

export interface Driver {
  /** Trades per second across all instruments. */
  ticksPerSecond: number;
  /** Orders per second placed from "another session". */
  externalOrdersPerSecond: number;
  heartbeatMs: number;
  paused: boolean;
  /** Adds the send time (`t`, ms since the epoch, fractional) to every event, for latency measurement. */
  stamp: boolean;
}

export interface ServerOptions extends Partial<MarketConfig> {
  port?: number;
  host?: string;
  /** URL prefix → directory of a built app. */
  statics?: Record<string, string>;
  driver?: Partial<Driver>;
}

export interface SandboxServer {
  readonly url: string;
  readonly market: Market;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

export async function startServer(options: ServerOptions = {}): Promise<SandboxServer> {
  let config: MarketConfig = { seed: options.seed ?? 1, instruments: options.instruments ?? 40, orders: options.orders ?? 30 };
  let faults: Faults = noFaults();
  const driver: Driver = { ticksPerSecond: 20, externalOrdersPerSecond: 0.5, heartbeatMs: 1000, paused: false, stamp: false, ...options.driver };
  let market = new Market(config);
  let unsubscribe = market.subscribe(broadcast);
  let httpRng = createRng(config.seed ^ 0x5bd1e995);
  let connections = 0;
  let refuseUntil = 0;
  const channels = new Map<WebSocket, Channel>();
  // Counters since the last reset.
  let wsStats: ChannelStats = emptyStats();
  const emptyHttpStats = () => ({ requests: {} as Record<string, number>, aborted: {} as Record<string, number>, errors: 0, corrupted: 0, committedThenFailed: 0 });
  let httpStats = emptyHttpStats();
  let wsCounts = { connections: 0, refused: 0, disconnects: 0 };
  const mounts = Object.entries(options.statics ?? {})
    .map(([prefix, dir]) => ({ prefix: prefix.endsWith("/") ? prefix : `${prefix}/`, dir: resolve(dir) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  function broadcast(e: MarketEvent): void {
    const t = driver.stamp ? performance.timeOrigin + performance.now() : undefined;
    for (const ch of channels.values()) {
      ch.send((s) => {
        const m = eventJson(e, s);
        if (t !== undefined) m["t"] = t;
        return m;
      });
    }
  }

  // Market driver: a 5 ms loop that runs as many ticks as the rate calls for.
  let last = performance.now();
  let tickDebt = 0;
  let orderDebt = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (driver.paused) return;
    tickDebt = Math.min(tickDebt + dt * driver.ticksPerSecond, 2000);
    orderDebt = Math.min(orderDebt + dt * driver.externalOrdersPerSecond, 100);
    for (; tickDebt >= 1; tickDebt--) market.tick();
    for (; orderDebt >= 1; orderDebt--) market.externalOrder();
  }, 5);

  let heartbeat: NodeJS.Timeout | undefined;
  const armHeartbeat = () => {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      const at = Date.now();
      for (const ch of channels.values()) ch.send((s) => heartbeatJson(market.epoch, market.seq, at, s));
    }, driver.heartbeatMs);
  };
  armHeartbeat();

  let disconnector: NodeJS.Timeout | undefined;
  let disconnectEvery = 0;
  const armDisconnector = () => {
    if (faults.ws.disconnectEveryMs === disconnectEvery) return;
    disconnectEvery = faults.ws.disconnectEveryMs;
    clearInterval(disconnector);
    if (disconnectEvery > 0) disconnector = setInterval(() => disconnectAll(faults.ws.disconnectMode), disconnectEvery);
  };

  function disconnectAll(mode: "close" | "terminate", code = 1012): void {
    refuseUntil = performance.now() + faults.ws.refuseMs;
    for (const [ws, ch] of channels) {
      ch.close();
      if (mode === "terminate") ws.terminate();
      else ws.close(code, "server restart");
      wsCounts.disconnects++;
    }
    channels.clear();
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  wss.on("connection", (ws) => {
    const ch = new Channel(ws, () => faults.ws, createRng(config.seed * 7919 + ++connections), wsStats);
    channels.set(ws, ch);
    wsCounts.connections++;
    ch.send(() => helloJson(market.epoch, market.seq, Date.now()), false);
    ws.on("close", () => {
      ch.close();
      channels.delete(ws);
    });
    ws.on("error", () => ws.terminate());
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });

  // /voice/echo: the voice sample's server, which sends every message straight back.
  const echo = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  echo.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    ws.on("error", () => ws.terminate());
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/voice/echo") {
      echo.handleUpgrade(req, socket, head, (ws) => echo.emit("connection", ws, req));
      return;
    }
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    if (performance.now() < refuseUntil) {
      wsCounts.refused++;
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  function count(table: Record<string, number>, key: string): void {
    table[key] = (table[key] ?? 0) + 1;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("Cache-Control", "no-store");

    if (path.startsWith("/admin/")) return admin(method, path, req, res);

    if (path.startsWith("/api/")) {
      const route = `${method} ${path.replace(/\/orders\/[^/]+/, "/orders/:id")}`;
      count(httpStats.requests, route);
      return api(method, path, url, route, req, res);
    }

    if (method === "GET" || method === "HEAD") return serveStatic(path, res);
    json(res, 404, { error: "not found" });
  }

  // ---- API -----------------------------------------------------------------

  async function api(method: string, path: string, url: URL, route: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (method === "GET" && path === "/api/snapshot") {
      const snap = market.snapshot();
      return reply(req, res, route, 200, (s) => snapshotJson(snap, s));
    }

    if (method === "GET" && path === "/api/instruments") {
      // Compared as received, like many real backends: names are stored in NFC,
      // so an NFD query only matches if the client normalized it.
      const q = url.searchParams.get("q") ?? "";
      const needle = q.toLowerCase();
      const items = [...market.instruments.values()]
        .filter((i) => needle === "" || i.symbol.startsWith(needle) || i.name.toLowerCase().includes(needle))
        .slice(0, 20)
        .map((i) => ({ ...i }));
      const delay = faults.http.searchDelays.shift();
      return reply(req, res, route, 200, (s) => ({ query: q, items: items.map((i) => instrumentJson(i, s)) }), delay);
    }

    const detail = /^\/api\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && detail) {
      const id = parseId(decodeURIComponent(detail[1]!));
      const o = id === undefined ? undefined : market.orders.get(id);
      const delay = faults.http.detailDelays.shift();
      if (o === undefined) return reply(req, res, route, 404, () => ({ error: "no such order" }), delay);
      const frozen = { ...o, fills: [...o.fills] };
      return reply(req, res, route, 200, (s) => orderDetailJson(frozen, s), delay);
    }

    const cancel = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      const id = parseId(decodeURIComponent(cancel[1]!));
      if (id === undefined) return reply(req, res, route, 404, () => ({ error: "no such order" }));
      const r = market.cancel(id);
      if (!r.ok) return reply(req, res, route, r.status, () => ({ error: r.error }));
      const o = { ...r.order };
      return reply(req, res, route, 200, (s) => ({ order: orderJson(o, s) }));
    }

    if (method === "POST" && path === "/api/orders") {
      const body = await readBody(req);
      if (body === undefined) return reply(req, res, route, 413, () => ({ error: "body too large" }));
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return reply(req, res, route, 400, () => ({ error: "body is not JSON" }));
      }
      const input = parseNewOrder(raw);
      if ("error" in input) return reply(req, res, route, 422, () => input);
      const r = market.place(input);
      if (!r.ok) return reply(req, res, route, r.status, () => ({ error: r.error, ...(r.field ? { field: r.field } : {}) }));
      if (r.created && chance(httpRng, faults.http.commitThenFailRate)) {
        httpStats.committedThenFailed++;
        return reply(req, res, route, 500, () => ({ error: "injected: committed, then failed" }));
      }
      const o = { ...r.order };
      return reply(req, res, route, r.created ? 201 : 200, (s) => ({ order: orderJson(o, s) }));
    }

    return reply(req, res, route, 404, () => ({ error: "not found" }));
  }

  /** Sends a JSON reply through the HTTP faults. The data was taken when the request arrived. */
  async function reply(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    status: number,
    build: (s: Style) => Record<string, unknown>,
    delayOverride?: number,
  ): Promise<void> {
    const f = faults.http;
    const delay = delayOverride ?? f.latencyMs + (f.jitterMs > 0 ? httpRng() * f.jitterMs : 0);
    if (delay > 0) {
      const aborted = await sleepUnlessClosed(res, delay);
      if (aborted) {
        count(httpStats.aborted, route);
        return;
      }
    }
    if (status < 400 && chance(httpRng, f.errorRate)) {
      httpStats.errors++;
      return json(res, 500, { error: "injected" });
    }
    const message = build({ rng: httpRng, variant: f.variantRate, drift: f.driftRate });
    if (f.padBytes > 0) message["_pad"] = "x".repeat(f.padBytes);
    let body = JSON.stringify(message);
    if (f.deepNesting > 0) body = `{"_deep":${"[".repeat(f.deepNesting)}${"]".repeat(f.deepNesting)}${body === "{}" ? "" : ","}${body.slice(1)}`;
    if (chance(httpRng, f.corruptRate)) {
      httpStats.corrupted++;
      body = body.slice(0, int(httpRng, 1, body.length - 1));
    }
    send(res, status, "application/json; charset=utf-8", body);
  }

  // ---- Admin -----------------------------------------------------------------

  async function admin(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = method === "POST" ? await readBody(req) : "";
    let input: Record<string, unknown> = {};
    if (body) {
      try {
        input = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "body is not JSON" });
      }
    }
    switch (`${method} ${path}`) {
      case "GET /admin/state":
        return json(res, 200, snapshotJson(market.snapshot(), PLAIN));
      case "GET /admin/stats":
        return json(res, 200, {
          epoch: market.epoch,
          seq: market.seq.toString(),
          http: httpStats,
          ws: { ...wsCounts, open: channels.size, ...wsStats },
        });
      case "GET /admin/faults":
        return json(res, 200, faults);
      case "POST /admin/faults": {
        const next = patchFaults(faults, input);
        if (typeof next === "string") return json(res, 400, { error: next });
        faults = next;
        armDisconnector();
        return json(res, 200, faults);
      }
      case "POST /admin/faults/clear":
        faults = { ...noFaults(), csp: faults.csp };
        armDisconnector();
        return json(res, 200, faults);
      case "GET /admin/driver":
        return json(res, 200, driver);
      case "POST /admin/driver": {
        for (const [k, v] of Object.entries(input)) {
          if (!(k in driver) || typeof v !== typeof driver[k as keyof Driver]) return json(res, 400, { error: `bad driver field ${k}` });
        }
        Object.assign(driver, input);
        armHeartbeat();
        return json(res, 200, driver);
      }
      case "POST /admin/reset": {
        // A new market (new epoch, seq from 0), as if the server restarted. Faults and counters are cleared.
        unsubscribe();
        config = {
          seed: typeof input["seed"] === "number" ? input["seed"] : config.seed,
          instruments: typeof input["instruments"] === "number" ? input["instruments"] : config.instruments,
          orders: typeof input["orders"] === "number" ? input["orders"] : config.orders,
        };
        faults = { ...noFaults(), csp: faults.csp };
        armDisconnector();
        market = new Market(config);
        unsubscribe = market.subscribe(broadcast);
        tickDebt = 0;
        orderDebt = 0;
        httpRng = createRng(config.seed ^ 0x5bd1e995);
        refuseUntil = 0;
        disconnectAll("close");
        wsStats = emptyStats();
        httpStats = emptyHttpStats();
        wsCounts = { connections: 0, refused: 0, disconnects: 0 };
        return json(res, 200, { epoch: market.epoch, seq: market.seq.toString() });
      }
      case "POST /admin/tick": {
        const n = typeof input["count"] === "number" ? input["count"] : 1;
        for (let k = 0; k < n; k++) market.tick();
        return json(res, 200, { seq: market.seq.toString() });
      }
      case "POST /admin/external-order":
        market.externalOrder();
        return json(res, 200, { seq: market.seq.toString() });
      case "POST /admin/disconnect":
        disconnectAll(input["mode"] === "terminate" ? "terminate" : "close");
        return json(res, 200, {});
      case "POST /admin/broadcast": {
        // A raw frame, sent through the latency stage only.
        const frame = typeof input["frame"] === "string" ? input["frame"] : "";
        const binary = input["binary"] === true;
        for (const ch of channels.values()) ch.sendRaw(binary ? Buffer.from(frame) : frame);
        return json(res, 200, { clients: channels.size });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  // ---- Static ----------------------------------------------------------------

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    const mount = mounts.find((m) => path === m.prefix.slice(0, -1) || path.startsWith(m.prefix));
    if (mount === undefined) return json(res, 404, { error: "not found" });
    if (path === mount.prefix.slice(0, -1)) {
      res.writeHead(301, { Location: mount.prefix }).end();
      return;
    }
    const rel = normalize(decodeURIComponent(path.slice(mount.prefix.length)));
    let file = join(mount.dir, rel);
    if (!file.startsWith(mount.dir + sep) && file !== mount.dir) return json(res, 403, { error: "forbidden" });
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    // Client-side routes fall back to the app's page; missing assets stay 404.
    if (info === undefined && extname(rel) === "") {
      file = join(mount.dir, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    if (info === undefined) return json(res, 404, { error: "not found" });
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      const policy = CSP[faults.csp];
      if (policy) res.setHeader("Content-Security-Policy", policy);
      // Cross-origin isolation: browsers then give performance.now() its full
      // resolution, which the latency and micro benchmarks rely on.
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    send(res, 200, type, await readFile(file));
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => ok());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    get market() {
      return market;
    },
    async close() {
      clearInterval(loop);
      clearInterval(heartbeat);
      clearInterval(disconnector);
      for (const [ws, ch] of channels) {
        ch.close();
        ws.terminate();
      }
      channels.clear();
      wss.close();
      for (const ws of echo.clients) ws.terminate();
      echo.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

const CSP: Record<Faults["csp"], string | undefined> = {
  none: undefined,
  wasm: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
  strict: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => ok(size > MAX_BODY ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Waits, and reports whether the client went away meanwhile (an aborted fetch). */
function sleepUnlessClosed(res: ServerResponse, ms: number): Promise<boolean> {
  return new Promise((ok) => {
    const done = (aborted: boolean) => {
      clearTimeout(timer);
      res.off("close", onClose);
      ok(aborted);
    };
    const onClose = () => done(!res.writableEnded);
    const timer = setTimeout(() => done(false), ms);
    res.on("close", onClose);
  });
}

const CANONICAL_INT = /^(?:0|-?[1-9][0-9]{0,18})$/;

function parseId(s: string): bigint | undefined {
  return CANONICAL_INT.test(s) ? BigInt(s) : undefined;
}

/** Int64 as the app sends it: a canonical decimal string, or a JSON number when exact. */
function parseInt64(v: unknown): bigint | undefined {
  if (typeof v === "string") return parseId(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return undefined;
}

/** A price in tenths from a decimal string with at most one fraction digit (trailing zeros allowed). */
function parsePrice(v: unknown): bigint | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(0|[1-9][0-9]{0,12})(?:\.([0-9])0*)?$/.exec(v);
  if (m === null) return undefined;
  return BigInt(m[1]!) * PRICE_SCALE + BigInt(m[2] ?? "0");
}

function parseNewOrder(raw: unknown): NewOrder | { error: string; field?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const clientOrderId = r["clientOrderId"];
  if (typeof clientOrderId !== "string" || clientOrderId.length < 1 || clientOrderId.length > 64) return { error: "clientOrderId must be 1 to 64 characters", field: "clientOrderId" };
  const instrumentId = parseInt64(r["instrumentId"]);
  if (instrumentId === undefined) return { error: "instrumentId must be an int64", field: "instrumentId" };
  const side = r["side"];
  if (side !== "buy" && side !== "sell") return { error: "side must be buy or sell", field: "side" };
  const quantity = parseInt64(r["quantity"]);
  if (quantity === undefined) return { error: "quantity must be an int64", field: "quantity" };
  const price = parsePrice(r["price"]);
  if (price === undefined) return { error: "price must be a decimal string with at most one fraction digit", field: "price" };
  const memo = r["memo"];
  if (typeof memo !== "string") return { error: "memo must be a string", field: "memo" };
  return { clientOrderId, instrumentId, side, quantity, price, memo };
}
