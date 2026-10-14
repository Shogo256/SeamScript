// One WebSocket client's outgoing path: drop → encode (variant / drift) → pad →
// corrupt → binary → duplicate → reorder → delay → socket. Each stage reads the
// current faults, so a test can switch them while the connection is open.
import type { WebSocket } from "ws";
import type { WsFaults } from "./faults.ts";
import { chance, int, type Rng, shuffle } from "./rng.ts";
import { PLAIN, type Style } from "./wire.ts";

export interface ChannelStats {
  sent: number;
  dropped: number;
  duplicated: number;
  corrupted: number;
  binary: number;
  padded: number;
  slowConsumers: number;
}

export function emptyStats(): ChannelStats {
  return { sent: 0, dropped: 0, duplicated: 0, corrupted: 0, binary: 0, padded: 0, slowConsumers: 0 };
}

/** A client this far behind is disconnected instead of buffering without bound. */
const MAX_BUFFERED = 64 * 1024 * 1024;

type Frame = string | Buffer;

export class Channel {
  private readonly ws: WebSocket;
  private readonly faults: () => WsFaults;
  private readonly rng: Rng;
  private readonly stats: ChannelStats;
  private held: Frame[] = [];
  private holdTimer: NodeJS.Timeout | undefined;
  private readonly queue: { frame: Frame; due: number }[] = [];
  private lastDue = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(ws: WebSocket, faults: () => WsFaults, rng: Rng, stats: ChannelStats) {
    this.ws = ws;
    this.faults = faults;
    this.rng = rng;
    this.stats = stats;
  }

  /** Sends a message built for this frame's style. Unfaultable messages only get latency. */
  send(build: (style: Style) => Record<string, unknown>, faultable = true): void {
    if (this.closed) return;
    const f = this.faults();
    if (!faultable) {
      this.delay(JSON.stringify(build(PLAIN)), f);
      return;
    }
    if (chance(this.rng, f.dropRate)) {
      this.stats.dropped++;
      return;
    }
    const message = build({ rng: this.rng, variant: f.variantRate, drift: f.driftRate });
    if (chance(this.rng, f.padRate)) {
      message["_pad"] = "x".repeat(f.padBytes);
      this.stats.padded++;
    }
    let frame: Frame = JSON.stringify(message);
    if (chance(this.rng, f.corruptRate)) {
      // Any proper prefix of a JSON object is invalid JSON.
      frame = frame.slice(0, int(this.rng, 1, frame.length - 1));
      this.stats.corrupted++;
    }
    if (chance(this.rng, f.binaryRate)) {
      frame = Buffer.from(frame);
      this.stats.binary++;
    }
    const copies = chance(this.rng, f.duplicateRate) ? 2 : 1;
    if (copies === 2) this.stats.duplicated++;
    for (let k = 0; k < copies; k++) this.reorder(frame, f);
  }

  /** A frame exactly as given, through the latency stage only. */
  sendRaw(frame: Frame): void {
    if (!this.closed) this.delay(frame, this.faults());
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.holdTimer);
    clearTimeout(this.timer);
    this.held = [];
    this.queue.length = 0;
  }

  private reorder(frame: Frame, f: WsFaults): void {
    if (f.reorderWindow <= 1 && this.held.length === 0) {
      this.delay(frame, f);
      return;
    }
    this.held.push(frame);
    if (this.held.length >= Math.max(1, f.reorderWindow)) this.flushHeld();
    else this.holdTimer ??= setTimeout(() => this.flushHeld(), f.reorderHoldMs);
  }

  private flushHeld(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    const frames = shuffle(this.rng, this.held);
    this.held = [];
    const f = this.faults();
    for (const frame of frames) this.delay(frame, f);
  }

  private delay(frame: Frame, f: WsFaults): void {
    const d = f.latencyMs + (f.jitterMs > 0 ? this.rng() * f.jitterMs : 0);
    if (d <= 0 && this.queue.length === 0) {
      this.write(frame);
      return;
    }
    // FIFO: jitter delays a frame, but never past the one behind it.
    const due = Math.max(this.lastDue, performance.now() + d);
    this.lastDue = due;
    this.queue.push({ frame, due });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = performance.now();
      while (this.queue.length > 0 && this.queue[0]!.due <= now + 0.5) this.write(this.queue.shift()!.frame);
      this.schedule();
    }, Math.max(0, this.queue[0]!.due - performance.now()));
  }

  private write(frame: Frame): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.stats.slowConsumers++;
      this.ws.terminate();
      return;
    }
    this.ws.send(frame);
    this.stats.sent++;
  }
}
