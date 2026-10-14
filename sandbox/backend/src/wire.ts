// How the market's state is written as JSON. A Style decides, value by value,
// whether to use the plain spelling, another spelling of the same value (a
// variant: the app must read both the same), or a different schema (drift: the
// app must reject it).
import { type Instrument, type MarketEvent, type Order, PRICE_SCALE, type Snapshot } from "./market.ts";
import { chance, type Rng, uuid } from "./rng.ts";

export interface Style {
  readonly rng: Rng;
  /** Probability of writing a value in another, equivalent spelling. */
  readonly variant: number;
  /** Probability of writing a value in a schema the app does not accept. */
  readonly drift: number;
}

export const PLAIN: Style = { rng: () => 1, variant: 0, drift: 0 };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The plain spelling is a string; a variant uses a JSON number when that is exact. */
function int64(v: bigint, s: Style): string | number {
  return v <= MAX_SAFE && v >= -MAX_SAFE && chance(s.rng, s.variant) ? Number(v) : v.toString();
}

/** Canonical decimal; a variant adds trailing zeros ("2345.50", "120.0"). */
export function decimal(units: bigint, s: Style = PLAIN): string {
  const int = units / PRICE_SCALE;
  const frac = units % PRICE_SCALE;
  const plain = frac === 0n ? int.toString() : `${int}.${frac}`;
  if (!chance(s.rng, s.variant)) return plain;
  return frac === 0n ? `${plain}.0` : `${plain}0`;
}

/** Drift: the price as a JSON number, which a Decimal must never be. */
function price(units: bigint, s: Style): string | number {
  return chance(s.rng, s.drift) ? Number(units) / Number(PRICE_SCALE) : decimal(units, s);
}

const JST = 9 * 60;

/**
 * ISO 8601 with an offset. Plain: Japan time with milliseconds. A variant writes
 * the same instant in UTC or in India time, with microsecond digits.
 */
export function zoned(ms: number, s: Style = PLAIN): string {
  const variant = chance(s.rng, s.variant);
  const offset = variant ? (s.rng() < 0.5 ? 0 : 5 * 60 + 30) : JST;
  const iso = new Date(ms + offset * 60_000).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const fraction = variant ? `${iso.slice(20, 23)}000` : iso.slice(20, 23);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const suffix = offset === 0 ? "Z" : `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${iso.slice(0, 19)}.${fraction}${suffix}`;
}

/** Names and memos are stored in NFC; a variant sends them decomposed. */
function text(nfc: string, s: Style): string {
  return chance(s.rng, s.variant) ? nfc.normalize("NFD") : nfc;
}

export function instrumentJson(i: Instrument, s: Style = PLAIN): Record<string, unknown> {
  return {
    id: int64(i.id, s),
    symbol: i.symbol,
    name: text(i.name, s),
    tickSize: decimal(i.tick, s),
    last: price(i.last, s),
    prevClose: decimal(i.prevClose, s),
    version: int64(i.version, s),
    updatedAt: zoned(i.updatedAt, s),
  };
}

export function orderJson(o: Order, s: Style = PLAIN): Record<string, unknown> {
  return {
    // Drift: the backend switched order ids to UUIDs.
    id: chance(s.rng, s.drift) ? uuid(s.rng) : int64(o.id, s),
    clientOrderId: o.clientOrderId,
    instrumentId: int64(o.instrumentId, s),
    side: o.side,
    quantity: int64(o.quantity, s),
    filled: int64(o.filled, s),
    price: decimal(o.price, s),
    status: o.status,
    memo: text(o.memo, s),
    version: int64(o.version, s),
    createdAt: zoned(o.createdAt, s),
    updatedAt: zoned(o.updatedAt, s),
  };
}

export function orderDetailJson(o: Order, s: Style = PLAIN): Record<string, unknown> {
  return {
    order: orderJson(o, s),
    fills: o.fills.map((f) => ({ quantity: int64(f.quantity, s), price: decimal(f.price, s), at: zoned(f.at, s) })),
  };
}

export function snapshotJson(snap: Snapshot, s: Style = PLAIN): Record<string, unknown> {
  return {
    epoch: snap.epoch,
    seq: int64(snap.seq, s),
    serverTime: zoned(snap.at, s),
    instruments: snap.instruments.map((i) => instrumentJson(i, s)),
    orders: snap.orders.map((o) => orderJson(o, s)),
  };
}

export function eventJson(e: MarketEvent, s: Style = PLAIN): Record<string, unknown> {
  if (e.kind === "tick") {
    return { type: "tick", seq: int64(e.seq, s), instrumentId: int64(e.instrument.id, s), last: price(e.instrument.last, s), at: zoned(e.instrument.updatedAt, s) };
  }
  return { type: "order", seq: int64(e.seq, s), order: orderJson(e.order, s) };
}

export function heartbeatJson(epoch: string, seq: bigint, at: number, s: Style = PLAIN): Record<string, unknown> {
  return { type: "heartbeat", epoch, seq: int64(seq, s), serverTime: zoned(at, s) };
}

export function helloJson(epoch: string, seq: bigint, at: number): Record<string, unknown> {
  return { type: "hello", epoch, seq: seq.toString(), serverTime: zoned(at) };
}
