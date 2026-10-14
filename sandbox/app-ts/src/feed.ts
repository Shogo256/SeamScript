// The same synchronization design as sandbox/app/src/feed.seam.ts (sequence
// numbers, held-back events, gap timer, snapshot resync, watchdog), in TypeScript + Zod.
import { Envelope, type Hello, type Heartbeat, type Instrument, type Order, type OrderEvent, ServerMessage, Snapshot, type Tick } from "./api";
import { describe, describeProblem, getJson, parse } from "./http";
import { latestLine } from "./latest";

export type FeedStatus = "connecting" | "syncing" | "live" | "offline" | "failed";

export interface Problem {
  readonly id: number;
  readonly at: number;
  readonly source: "ws" | "snapshot";
  readonly kind: "frame" | "json" | "decode" | "http" | "epoch" | "unknown-entity";
  readonly message: string;
  readonly seq?: number;
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

export interface FeedMeta {
  readonly status: FeedStatus;
  readonly epoch: string | null;
  readonly seq: number;
  readonly serverSeq: number;
  readonly pending: number;
  readonly counters: Readonly<Counters>;
  readonly fatal: string | null;
}

export interface InstrumentInfo {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly tickSize: string;
}

type Event = Tick | OrderEvent;

const MAX_PENDING = 5000;
/** While a snapshot is awaited, events are held for it; this bounds them (about 10 MB). */
const MAX_PENDING_WHILE_SYNCING = 50_000;
const MAX_PROBLEMS = 50;

export class Feed {
  meta: FeedMeta;
  instruments = new Map<string, Instrument>();
  instrumentIds: readonly string[] = [];
  info = new Map<string, InstrumentInfo>();
  orders = new Map<string, Order>();
  orderIds: readonly string[] = [];
  problems: readonly Problem[] = [];

  private readonly url: string;
  private readonly gapMs: number;
  private readonly silenceMs: number;
  private readonly snapshot = latestLine((signal: AbortSignal) => getJson("/api/snapshot", Snapshot, signal));
  private readonly listeners = new Set<() => void>();
  private readonly counters: Counters = { frames: 0, applied: 0, duplicates: 0, rejected: 0, gaps: 0, resyncs: 0, snapshots: 0, connects: 0, disconnects: 0 };
  private epoch: string | null = null;
  private seq = 0;
  private serverSeq = 0;
  private pending = new Map<number, Event>();
  private ws: WebSocket | null = null;
  private connEpoch: string | null = null;
  private syncing = true;
  private stopped = false;
  private attempt = 0;
  private snapshotFailures = 0;
  private lastFrameAt = 0;
  private problemId = 0;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private readonly handleTimes = new Float64Array(1024);
  private handled = 0;
  private frameRequested = false;
  private readonly renderEach: boolean;

  constructor(options: { url?: string; gapMs?: number; silenceMs?: number; render?: "frame" | "each" } = {}) {
    this.url = options.url ?? new URL("/ws", location.href).href.replace(/^http/, "ws");
    this.gapMs = options.gapMs ?? 400;
    this.silenceMs = options.silenceMs ?? 3500;
    this.renderEach = options.render === "each";
    this.meta = this.buildMeta();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.snapshot.cancel();
    this.closeSocket();
    clearTimeout(this.gapTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.reconnectTimer);
  }

  frameTimes(): { p50: number; p99: number; n: number } {
    const n = Math.min(this.handled, this.handleTimes.length);
    if (n === 0) return { p50: 0, p99: 0, n: 0 };
    const sorted = this.handleTimes.slice(0, n).sort();
    return { p50: sorted[Math.floor(n * 0.5)]!, p99: sorted[Math.min(n - 1, Math.floor(n * 0.99))]!, n };
  }

  digest(): { epoch: string | null; seq: string; instruments: string[][]; orders: string[][] } {
    return {
      epoch: this.epoch,
      seq: `${this.seq}`,
      instruments: this.instrumentIds.map((id) => {
        const i = this.instruments.get(id)!;
        return [i.id, i.last, `${i.version}`, `${BigInt(Date.parse(i.updatedAt)) * 1_000_000n}`];
      }),
      orders: this.orderIds.map((id) => {
        const o = this.orders.get(id)!;
        return [o.id, o.status, `${o.filled}`, `${o.version}`, o.memo];
      }),
    };
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.lastFrameAt = Date.now();
    ws.addEventListener("message", (e) => {
      if (this.ws === ws) this.onFrame(e);
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.onClosed();
    });
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.ws === ws && Date.now() - this.lastFrameAt > this.silenceMs) {
        this.closeSocket();
        this.onClosed();
      }
    }, this.silenceMs / 4);
    this.notify();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.watchdog);
    ws?.close();
  }

  private onClosed(): void {
    this.ws = null;
    this.connEpoch = null;
    this.counters.disconnects++;
    clearInterval(this.watchdog);
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(5000, 100 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.notify();
  }

  private onFrame(e: MessageEvent): void {
    const t0 = performance.now();
    this.lastFrameAt = Date.now();
    this.counters.frames++;
    this.handleFrame(e);
    this.handleTimes[this.handled++ % this.handleTimes.length] = performance.now() - t0;
    this.notify();
  }

  private handleFrame(e: MessageEvent): void {
    if (typeof e.data !== "string") return this.reject("frame", "non-text frame");
    let raw: unknown;
    try {
      raw = JSON.parse(e.data);
    } catch (x) {
      return this.reject("json", `frame is not valid JSON: ${describe(x)}`);
    }
    const m = parse(ServerMessage, raw);
    if (!m.ok) {
      const envelope = parse(Envelope, raw);
      const seq = envelope.ok ? envelope.value.seq : undefined;
      this.reject("decode", describeProblem(m.error), seq);
      if (seq !== undefined && seq > this.serverSeq) this.serverSeq = seq;
      this.checkGap();
      return;
    }
    const msg = m.value;
    switch (msg.type) {
      case "hello":
        return this.onHello(msg);
      case "heartbeat":
        return this.onHeartbeat(msg);
      default:
        return this.onEvent(msg);
    }
  }

  private onHello(h: Hello): void {
    this.counters.connects++;
    this.attempt = 0;
    if (this.epoch !== null && h.epoch !== this.epoch) this.restarted(h.epoch);
    this.connEpoch = h.epoch;
    if (h.seq > this.serverSeq) this.serverSeq = h.seq;
    if (!this.syncing && h.epoch === this.epoch && h.seq === this.seq) {
      this.checkGap();
      return;
    }
    void this.resync();
  }

  private onHeartbeat(h: Heartbeat): void {
    if (this.connEpoch !== null && h.epoch !== this.connEpoch) {
      this.restarted(h.epoch);
      this.connEpoch = h.epoch;
      void this.resync();
      return;
    }
    if (h.seq > this.serverSeq) this.serverSeq = h.seq;
    this.checkGap();
  }

  private restarted(epoch: string): void {
    this.problem("ws", "epoch", `server restarted (epoch ${this.epoch} → ${epoch})`);
    this.pending.clear();
    this.serverSeq = 0;
    this.syncing = true;
  }

  private onEvent(ev: Event): void {
    if (ev.seq > this.serverSeq) this.serverSeq = ev.seq;
    if ((!this.syncing && ev.seq <= this.seq) || this.pending.has(ev.seq)) {
      this.counters.duplicates++;
      return;
    }
    if (this.syncing && this.pending.size >= MAX_PENDING_WHILE_SYNCING) {
      // No snapshot for a long time (the server keeps failing): hold a bounded
      // number, dropping the oldest. The snapshot will be newer than those; if
      // it is not, the hole shows up as a gap and leads to another snapshot.
      this.pending.delete(this.pending.keys().next().value!);
    }
    this.pending.set(ev.seq, ev);
    if (!this.syncing) this.drain();
  }

  private drain(): void {
    let addedOrders = false;
    for (let next = this.pending.get(this.seq + 1); next !== undefined; next = this.pending.get(this.seq + 1)) {
      this.pending.delete(next.seq);
      addedOrders = this.apply(next) || addedOrders;
      this.seq = next.seq;
      this.counters.applied++;
    }
    if (addedOrders) this.sortOrderIds();
    this.checkGap();
  }

  private apply(ev: Event): boolean {
    if (ev.type === "tick") {
      const i = this.instruments.get(ev.instrumentId);
      if (i === undefined) {
        this.problem("ws", "unknown-entity", `fill for unknown instrument ${ev.instrumentId}`);
        return false;
      }
      if (ev.seq > i.version) this.instruments.set(i.id, { ...i, last: ev.last, version: ev.seq, updatedAt: ev.at });
      return false;
    }
    const o = ev.order;
    const current = this.orders.get(o.id);
    if (current === undefined || o.version > current.version) this.orders.set(o.id, o);
    return current === undefined;
  }

  private sortOrderIds(): void {
    // Ids are decimal strings longer than 2^53 allows: compare by length, then text.
    this.orderIds = [...this.orders.keys()].sort((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0));
  }

  private checkGap(): void {
    const behind = this.pending.size > 0 || this.serverSeq > this.seq;
    if (this.syncing || !behind) {
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
      return;
    }
    if (this.pending.size > MAX_PENDING) {
      void this.resync();
      return;
    }
    if (this.gapTimer !== undefined) return;
    const waitingFor = this.seq + 1;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined;
      if (this.syncing) return;
      if (this.seq < waitingFor) {
        this.counters.gaps++;
        void this.resync();
      } else {
        this.checkGap();
      }
      this.notify();
    }, this.gapMs);
  }

  private async resync(): Promise<void> {
    this.syncing = true;
    this.counters.resyncs++;
    clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
    clearTimeout(this.retryTimer);
    this.notify();
    const r = await this.snapshot();
    if (r.ok) return this.applySnapshot(r.value);
    const error = r.error;
    if (error.kind === "stale") return;
    this.problem("snapshot", error.kind === "decode" ? "decode" : "http", `snapshot: ${describeProblem(error)}`);
    this.snapshotFailures++;
    this.retryTimer = setTimeout(() => void this.resync(), Math.min(5000, 200 * 2 ** (this.snapshotFailures - 1)));
    this.notify();
  }

  private applySnapshot(s: Snapshot): void {
    this.counters.snapshots++;
    this.snapshotFailures = 0;
    if (this.connEpoch !== null && s.epoch !== this.connEpoch) {
      this.problem("snapshot", "epoch", `snapshot epoch ${s.epoch} differs from the connection's epoch ${this.connEpoch}`);
      this.retryTimer = setTimeout(() => void this.resync(), 200);
      this.notify();
      return;
    }
    const sameEpoch = s.epoch === this.epoch;
    if (!sameEpoch || s.seq >= this.seq) {
      this.epoch = s.epoch;
      this.seq = s.seq;
      if (!sameEpoch || s.seq > this.serverSeq) this.serverSeq = s.seq;
      this.instruments = reuse(this.instruments, s.instruments, sameEpoch);
      const ids = s.instruments.map((i) => i.id);
      if (!sameIds(ids, this.instrumentIds)) this.instrumentIds = ids;
      if (!sameEpoch) this.info = new Map(s.instruments.map((i) => [i.id, { id: i.id, symbol: i.symbol, name: i.name, tickSize: i.tickSize }]));
      this.orders = reuse(this.orders, s.orders, sameEpoch);
      this.sortOrderIds();
    }
    for (const k of this.pending.keys()) if (k <= this.seq) this.pending.delete(k);
    this.syncing = false;
    this.drain();
    this.notify();
  }

  private reject(kind: Problem["kind"], message: string, seq?: number): void {
    this.counters.rejected++;
    this.problem("ws", kind, message, seq);
  }

  private problem(source: Problem["source"], kind: Problem["kind"], message: string, seq?: number): void {
    const p: Problem = { id: ++this.problemId, at: Date.now(), source, kind, message, ...(seq === undefined ? {} : { seq }) };
    this.problems = [p, ...this.problems.slice(0, MAX_PROBLEMS - 1)];
  }

  private status(): FeedStatus {
    if (this.connEpoch === null) return this.epoch === null ? "connecting" : "offline";
    if (this.syncing) return "syncing";
    return "live";
  }

  private buildMeta(): FeedMeta {
    return { status: this.status(), epoch: this.epoch, seq: this.seq, serverSeq: this.serverSeq, pending: this.pending.size, counters: { ...this.counters }, fatal: null };
  }

  /**
   * Views are told about changes at most once per animation frame. Applying an
   * event is cheap; rendering after every one is not, and at around a thousand
   * messages a second it saturated the main thread, so WebSocket messages queued
   * up and the screen fell seconds behind. The state itself is always current.
   */
  private notify(): void {
    if (this.renderEach) {
      this.meta = this.buildMeta();
      for (const l of this.listeners) l();
      return;
    }
    if (this.frameRequested) return;
    this.frameRequested = true;
    nextFrame(() => {
      this.frameRequested = false;
      this.meta = this.buildMeta();
      for (const l of this.listeners) l();
    });
  }
}

function reuse<T extends { id: string; version: number }>(old: Map<string, T>, next: readonly T[], sameEpoch: boolean): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of next) {
    const prev = sameEpoch ? old.get(x.id) : undefined;
    out.set(x.id, prev !== undefined && prev.version === x.version ? prev : x);
  }
  return out;
}

const nextFrame: (f: () => void) => void =
  typeof requestAnimationFrame === "function" ? (f) => void requestAnimationFrame(f) : (f) => void setTimeout(f, 16);

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
