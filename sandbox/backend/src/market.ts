// The authoritative state the app has to mirror: instruments whose prices move,
// and orders that fill when the price crosses them. Every change gets the next
// sequence number, which is also the changed entity's version.
import { Text } from "@seamscript/runtime";
import { chance, createRng, int, pick, type Rng } from "./rng.ts";

/** Prices are integers in tenths: 23455n is 2345.5. */
export const PRICE_SCALE = 10n;

/** Order ids start above 2^53, where a JavaScript number can no longer hold every integer. */
export const FIRST_ORDER_ID = (1n << 53n) + 1n;

export const MEMO_MAX_GRAPHEMES = 32;
export const MEMO_MAX_BYTES = 256;

export type Side = "buy" | "sell";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface Instrument {
  readonly id: bigint;
  readonly symbol: string;
  /** NFC. */
  readonly name: string;
  readonly tick: bigint;
  last: bigint;
  readonly prevClose: bigint;
  version: bigint;
  /** Epoch milliseconds. */
  updatedAt: number;
}

export interface Fill {
  readonly quantity: bigint;
  readonly price: bigint;
  readonly at: number;
}

export interface Order {
  readonly id: bigint;
  readonly clientOrderId: string;
  readonly instrumentId: bigint;
  readonly side: Side;
  readonly quantity: bigint;
  filled: bigint;
  readonly price: bigint;
  status: OrderStatus;
  /** NFC. */
  readonly memo: string;
  version: bigint;
  readonly createdAt: number;
  updatedAt: number;
  readonly fills: Fill[];
}

export type MarketEvent =
  | { readonly kind: "tick"; readonly seq: bigint; readonly instrument: Instrument }
  | { readonly kind: "order"; readonly seq: bigint; readonly order: Order };

export interface Snapshot {
  readonly epoch: string;
  readonly seq: bigint;
  readonly at: number;
  readonly instruments: readonly Instrument[];
  readonly orders: readonly Order[];
}

export interface NewOrder {
  clientOrderId: string;
  instrumentId: bigint;
  side: Side;
  quantity: bigint;
  price: bigint;
  memo: string;
}

export type PlaceResult =
  | { ok: true; order: Order; created: boolean }
  | { ok: false; status: number; error: string; field?: string };

export interface MarketOptions {
  seed: number;
  instruments: number;
  orders: number;
  now?: () => number;
}

// Fictional companies. The names exercise Text: dakuten and handakuten (NFD splits
// them), a supplementary-plane kanji, an ideographic variation sequence, emoji
// (plain, flag, ZWJ), halfwidth katakana with a separate voiced mark, Hangul (NFD
// is jamo), Latin and Greek accents, the Angstrom sign (NFC changes it to Å), and
// a Devanagari conjunct.
const NAMES = [
  "東都電機", "北辰製薬", "みらい銀行", "ガイア通信", "ヴィーナス化粧品", "ポラリス重工", "さくら鉄道",
  "𠮷田精機", "葛󠄀飾工業", "🍣スシテック", "Café Lumière", "ﾊﾞﾝｶﾞｸ物産", "🇯🇵ジャパン・フラッグ",
  "👨‍👩‍👧ファミリー・ホーム", "नमस्ते トレーディング", "Ελληνική Ναυτιλία", "한빛 반도체", "あおば住宅",
  "日本ﾃﾞｰﾀ通信", "Ångström Optics", "大和重工", "東洋化学", "富士山不動産", "瀬戸内海運", "九州グリッド",
  "札幌ビール工房", "横浜港湾", "名古屋モビリティ", "京都織物", "浪速商事", "神戸鋼材", "広島精密",
  "仙台エネルギー", "新潟米穀", "琉球リゾート", "北海水産", "信州精機", "四国製紙", "金沢漆器", "長崎造船",
].map((n) => n.normalize("NFC"));

const MEMOS = ["", "利確目標 🎯", "決算前に買い増し", "👨‍👩‍👧 家族口座", "Café 用", "ナンピン", "損切り -3%", "𠮷日", "ﾃﾞｲﾄﾚ"];

export class Market {
  readonly epoch: string;
  seq = 0n;
  readonly instruments = new Map<bigint, Instrument>();
  readonly orders = new Map<bigint, Order>();
  private readonly list: Instrument[] = [];
  private readonly byClientId = new Map<string, bigint>();
  /** Instrument id → ids of its open or partially filled orders. */
  private readonly active = new Map<bigint, Set<bigint>>();
  private nextOrderId = FIRST_ORDER_ID;
  private external = 0;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly listeners = new Set<(e: MarketEvent) => void>();

  constructor(options: MarketOptions) {
    this.rng = createRng(options.seed);
    this.now = options.now ?? Date.now;
    this.epoch = `${options.seed.toString(36)}-${this.now().toString(36)}`;
    const t = this.now();
    for (let k = 0; k < options.instruments; k++) {
      const tick = pick(this.rng, [1n, 10n, 10n, 50n]);
      const prevClose = (BigInt(int(this.rng, 300, 90_000)) / tick) * tick;
      const i: Instrument = {
        id: BigInt(1001 + k),
        symbol: String(1301 + k * 7),
        name: k < NAMES.length ? NAMES[k]! : `Instrument ${k + 1}`,
        tick,
        last: prevClose,
        prevClose,
        version: 0n,
        updatedAt: t,
      };
      this.instruments.set(i.id, i);
      this.list.push(i);
      this.active.set(i.id, new Set());
    }
    for (let k = 0; k < options.orders; k++) this.addExternalOrder(t, false);
  }

  subscribe(listener: (e: MarketEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Snapshot {
    return {
      epoch: this.epoch,
      seq: this.seq,
      at: this.now(),
      instruments: this.list.map((i) => ({ ...i })),
      orders: [...this.orders.values()].map((o) => ({ ...o, fills: [...o.fills] })),
    };
  }

  /** One trade on a random instrument, and the fills it causes. */
  tick(): void {
    if (this.list.length === 0) return;
    const i = pick(this.rng, this.list);
    const step = BigInt(int(this.rng, 1, 3)) * (this.rng() < 0.5 ? -1n : 1n) * i.tick;
    // Daily price limit of ±30%, and never below one tick.
    const lo = maxBig(i.tick, ((i.prevClose * 7n) / 10n / i.tick) * i.tick);
    const hi = ((i.prevClose * 13n) / 10n / i.tick) * i.tick;
    i.last = minBig(hi, maxBig(lo, i.last + step));
    i.version = ++this.seq;
    i.updatedAt = this.now();
    this.emit({ kind: "tick", seq: i.version, instrument: { ...i } });
    this.match(i);
  }

  /** An order placed from another session of the same account. */
  externalOrder(): void {
    this.addExternalOrder(this.now(), true);
  }

  place(input: NewOrder): PlaceResult {
    const existing = this.byClientId.get(input.clientOrderId);
    if (existing !== undefined) {
      const o = this.orders.get(existing)!;
      const same =
        o.instrumentId === input.instrumentId && o.side === input.side && o.quantity === input.quantity && o.price === input.price && o.memo === input.memo.normalize("NFC");
      // A retry of the same request returns the order it created; anything else reusing the key is a conflict.
      return same ? { ok: true, order: o, created: false } : { ok: false, status: 409, error: "clientOrderId was already used for a different order", field: "clientOrderId" };
    }
    const i = this.instruments.get(input.instrumentId);
    if (i === undefined) return { ok: false, status: 422, error: "unknown instrument", field: "instrumentId" };
    if (input.quantity <= 0n || input.quantity > 1_000_000_000n) return { ok: false, status: 422, error: "quantity must be 1 to 1000000000", field: "quantity" };
    if (input.price <= 0n || input.price % i.tick !== 0n) return { ok: false, status: 422, error: "price must be a positive multiple of the tick size", field: "price" };
    const memo = checkMemo(input.memo);
    if (typeof memo !== "string") return { ok: false, status: 422, error: memo.error, field: "memo" };
    const t = this.now();
    const o: Order = {
      id: this.takeOrderId(),
      clientOrderId: input.clientOrderId,
      instrumentId: i.id,
      side: input.side,
      quantity: input.quantity,
      filled: 0n,
      price: input.price,
      status: "open",
      memo,
      version: ++this.seq,
      createdAt: t,
      updatedAt: t,
      fills: [],
    };
    this.insert(o);
    this.emit({ kind: "order", seq: o.version, order: copy(o) });
    this.match(i);
    return { ok: true, order: o, created: true };
  }

  cancel(id: bigint): PlaceResult {
    const o = this.orders.get(id);
    if (o === undefined) return { ok: false, status: 404, error: "no such order" };
    if (o.status !== "open" && o.status !== "partially_filled") return { ok: false, status: 409, error: `order is ${o.status}` };
    o.status = "cancelled";
    o.version = ++this.seq;
    o.updatedAt = this.now();
    this.active.get(o.instrumentId)!.delete(o.id);
    this.emit({ kind: "order", seq: o.version, order: copy(o) });
    return { ok: true, order: o, created: false };
  }

  private match(i: Instrument): void {
    for (const id of [...this.active.get(i.id)!]) {
      const o = this.orders.get(id)!;
      const crosses = o.side === "buy" ? o.price >= i.last : o.price <= i.last;
      if (!crosses) continue;
      const lot = minBig(o.quantity - o.filled, BigInt(int(this.rng, 1, 10)) * 100n);
      const t = this.now();
      o.filled += lot;
      o.fills.push({ quantity: lot, price: i.last, at: t });
      o.status = o.filled === o.quantity ? "filled" : "partially_filled";
      o.version = ++this.seq;
      o.updatedAt = t;
      if (o.status === "filled") this.active.get(i.id)!.delete(o.id);
      this.emit({ kind: "order", seq: o.version, order: copy(o) });
    }
  }

  private addExternalOrder(t: number, emit: boolean): void {
    if (this.list.length === 0) return;
    const i = pick(this.rng, this.list);
    const side: Side = this.rng() < 0.5 ? "buy" : "sell";
    const away = BigInt(int(this.rng, 1, 20)) * i.tick;
    const quantity = BigInt(int(this.rng, 1, 50)) * 100n;
    const o: Order = {
      id: this.takeOrderId(),
      clientOrderId: `ext-${++this.external}`,
      instrumentId: i.id,
      side,
      quantity,
      filled: 0n,
      price: side === "buy" ? maxBig(i.tick, i.last - away) : i.last + away,
      status: "open",
      memo: pick(this.rng, MEMOS).normalize("NFC"),
      version: ++this.seq,
      createdAt: t,
      updatedAt: t,
      fills: [],
    };
    // Some of the initial orders are already done.
    if (!emit && chance(this.rng, 0.3)) {
      o.status = chance(this.rng, 0.5) ? "filled" : "cancelled";
      if (o.status === "filled") {
        o.filled = o.quantity;
        o.fills.push({ quantity: o.quantity, price: o.price, at: t });
      }
    }
    this.insert(o);
    if (emit) this.emit({ kind: "order", seq: o.version, order: copy(o) });
  }

  private insert(o: Order): void {
    this.orders.set(o.id, o);
    this.byClientId.set(o.clientOrderId, o.id);
    if (o.status === "open" || o.status === "partially_filled") this.active.get(o.instrumentId)!.add(o.id);
  }

  private takeOrderId(): bigint {
    const id = this.nextOrderId;
    // Gaps, so that ids are not consecutive (and some are odd: not representable as doubles).
    this.nextOrderId += BigInt(int(this.rng, 1, 97));
    return id;
  }

  private emit(e: MarketEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/**
 * The server's memo rule, using the same Text as the app: with @seamscript/core
 * loaded, both count graphemes by the same Unicode version. The byte limit is
 * separate because one grapheme can be arbitrarily long (a base letter followed
 * by thousands of combining marks).
 */
export function checkMemo(memo: string): string | { error: string } {
  if (!memo.isWellFormed()) return { error: "memo is not well-formed UTF-16" };
  const nfc = Text.nfc(memo);
  if (Text.length(nfc) > MEMO_MAX_GRAPHEMES) return { error: `memo must be at most ${MEMO_MAX_GRAPHEMES} characters` };
  if (Buffer.byteLength(nfc, "utf8") > MEMO_MAX_BYTES) return { error: `memo must be at most ${MEMO_MAX_BYTES} bytes` };
  return nfc;
}

function copy(o: Order): Order {
  return { ...o, fills: [...o.fills] };
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
