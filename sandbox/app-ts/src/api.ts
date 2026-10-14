// The same API as sandbox/app/src/api.seam.ts, written the usual TypeScript way:
// Zod schemas, ids kept as strings, prices as decimal strings, times as ISO strings.
import { z } from "zod";

/** An integer sent as a JSON number or as a decimal string. Kept as a number (the values here stay below 2^53). */
const int = z.union([z.number().int(), z.string().regex(/^(0|-?[1-9][0-9]*)$/).transform(Number)]);
/** Ids can exceed 2^53, so they stay strings. */
const id = z.union([z.string().regex(/^(0|-?[1-9][0-9]*)$/), z.number().int().transform(String)]);
const decimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const datetime = z.iso.datetime({ offset: true });

export const Instrument = z.object({
  id,
  symbol: z.string(),
  name: z.string(),
  tickSize: decimal,
  last: decimal,
  prevClose: decimal,
  version: int,
  updatedAt: datetime,
});
export type Instrument = z.infer<typeof Instrument>;

export const Order = z.object({
  id,
  clientOrderId: z.string(),
  instrumentId: id,
  side: z.enum(["buy", "sell"]),
  quantity: int,
  filled: int,
  price: decimal,
  status: z.enum(["open", "partially_filled", "filled", "cancelled"]),
  memo: z.string(),
  version: int,
  createdAt: datetime,
  updatedAt: datetime,
});
export type Order = z.infer<typeof Order>;

export const Fill = z.object({ quantity: int, price: decimal, at: datetime });
export type Fill = z.infer<typeof Fill>;

export const OrderDetail = z.object({ order: Order, fills: z.array(Fill) });

export const Snapshot = z.object({
  epoch: z.string(),
  seq: int,
  serverTime: datetime,
  instruments: z.array(Instrument),
  orders: z.array(Order),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SearchResult = z.object({ query: z.string(), items: z.array(Instrument) });
export type SearchResult = z.infer<typeof SearchResult>;

const Hello = z.object({ type: z.literal("hello"), epoch: z.string(), seq: int, serverTime: datetime });
const Heartbeat = z.object({ type: z.literal("heartbeat"), epoch: z.string(), seq: int, serverTime: datetime });
const Tick = z.object({ type: z.literal("tick"), seq: int, instrumentId: id, last: decimal, at: datetime });
const OrderEvent = z.object({ type: z.literal("order"), seq: int, order: Order });

export const ServerMessage = z.discriminatedUnion("type", [Hello, Heartbeat, Tick, OrderEvent]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type Hello = z.infer<typeof Hello>;
export type Heartbeat = z.infer<typeof Heartbeat>;
export type Tick = z.infer<typeof Tick>;
export type OrderEvent = z.infer<typeof OrderEvent>;

export const Envelope = z.object({ seq: int });

export interface NewOrder {
  clientOrderId: string;
  instrumentId: string;
  side: "buy" | "sell";
  quantity: number;
  price: string;
  memo: string;
}

export const OrderAccepted = z.object({ order: Order });
export const ApiError = z.object({ error: z.string(), field: z.string().optional() });
