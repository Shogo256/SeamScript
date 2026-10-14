// The fault stages really do what the E2E scenarios rely on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { Channel, emptyStats } from "../src/channel.ts";
import { noFaults, patchFaults, type WsFaults } from "../src/faults.ts";
import { createRng } from "../src/rng.ts";

function fakeSocket(): { ws: WebSocket; frames: (string | Buffer)[] } {
  const frames: (string | Buffer)[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (f: string | Buffer) => frames.push(f), terminate() {} } as unknown as WebSocket;
  return { ws, frames };
}

function channel(patch: Partial<WsFaults>) {
  const { ws, frames } = fakeSocket();
  const faults = { ...noFaults().ws, ...patch };
  const stats = emptyStats();
  const ch = new Channel(ws, () => faults, createRng(7), stats);
  const send = (n: number) => {
    for (let i = 1; i <= n; i++) ch.send(() => ({ seq: i }));
  };
  const seqs = () => frames.map((f) => (JSON.parse(String(f)) as { seq: number }).seq);
  return { ch, frames, stats, send, seqs };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("no faults: every frame, in order, at once", () => {
  const c = channel({});
  c.send(100);
  assert.deepEqual(c.seqs(), Array.from({ length: 100 }, (_, i) => i + 1));
});

test("drop, duplicate and corrupt happen at roughly their rates", () => {
  const n = 5000;
  const drop = channel({ dropRate: 0.1 });
  drop.send(n);
  assert.ok(Math.abs(drop.stats.dropped / n - 0.1) < 0.02, `dropped ${drop.stats.dropped}`);
  assert.equal(drop.frames.length, n - drop.stats.dropped);

  const dup = channel({ duplicateRate: 0.3 });
  dup.send(n);
  assert.ok(Math.abs(dup.stats.duplicated / n - 0.3) < 0.03);
  assert.equal(dup.frames.length, n + dup.stats.duplicated);

  const bad = channel({ corruptRate: 0.05 });
  bad.send(n);
  const invalid = bad.frames.filter((f) => {
    try {
      JSON.parse(String(f));
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(invalid.length, bad.stats.corrupted);
  assert.ok(bad.stats.corrupted > 150);
});

test("reorder shuffles within windows and loses nothing", async () => {
  const c = channel({ reorderWindow: 8 });
  c.send(800);
  await wait(50); // the hold timer flushes a partial window
  const s = c.seqs();
  assert.deepEqual([...s].sort((a, b) => a - b), Array.from({ length: 800 }, (_, i) => i + 1));
  assert.notDeepEqual(s, [...s].sort((a, b) => a - b));
  // Never further than one window from its place.
  s.forEach((seq, i) => assert.ok(Math.abs(seq - (i + 1)) < 8));
});

test("latency with jitter delays frames but keeps their order", async () => {
  const c = channel({ latencyMs: 20, jitterMs: 30 });
  const t0 = performance.now();
  c.send(50);
  assert.equal(c.frames.length, 0);
  await wait(80);
  assert.deepEqual(c.seqs(), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.ok(performance.now() - t0 >= 20);
});

test("binary frames are Buffers", () => {
  const c = channel({ binaryRate: 1 });
  c.send(3);
  assert.ok(c.frames.every((f) => Buffer.isBuffer(f)));
});

test("a fault patch with a typo is refused, not ignored", () => {
  assert.equal(patchFaults(noFaults(), { ws: { dropRte: 0.1 } }), "unknown fault ws.dropRte");
  assert.equal(patchFaults(noFaults(), { ws: { dropRate: "0.1" } }), "ws.dropRate must be a number");
  assert.equal(typeof patchFaults(noFaults(), { ws: { dropRate: 0.1 }, csp: "strict" }), "object");
});
