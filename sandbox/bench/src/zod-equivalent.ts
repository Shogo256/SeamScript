// Zod schemas that do roughly the work SeamScript's decoders do, so that the
// comparison separates "how fast" from "how much is checked": Int64 to bigint
// with the canonical-form and range checks, Decimal normalized, Text checked for
// lone surrogates and normalized to NFC (with the host's ICU). Zoned is only
// validated (not rewritten to a canonical form), so Zod does slightly less there.
import { z } from "zod";

const MIN = -(1n << 63n);
const MAX = (1n << 63n) - 1n;
const int64 = z
  .union([z.number().int().refine(Number.isSafeInteger), z.string().regex(/^(?:0|-?[1-9][0-9]{0,18})$/)])
  .transform((v) => BigInt(v))
  .refine((v) => v >= MIN && v <= MAX);

const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const decimal = z
  .string()
  .regex(DECIMAL)
  .transform((s) => {
    const m = DECIMAL.exec(s)!;
    const frac = (m[3] ?? "").replace(/0+$/, "");
    const body = frac === "" ? m[2]! : `${m[2]}.${frac}`;
    return body === "0" ? "0" : m[1] + body;
  });

const text = z
  .string()
  .refine((s) => s.isWellFormed())
  .transform((s) => s.normalize("NFC"));

const zoned = z.iso.datetime({ offset: true });

export const Instrument = z.object({
  id: int64,
  symbol: z.string(),
  name: text,
  tickSize: decimal,
  last: decimal,
  prevClose: decimal,
  version: int64,
  updatedAt: zoned,
});

export const Order = z.object({
  id: int64,
  clientOrderId: z.string(),
  instrumentId: int64,
  side: z.enum(["buy", "sell"]),
  quantity: int64,
  filled: int64,
  price: decimal,
  status: z.enum(["open", "partially_filled", "filled", "cancelled"]),
  memo: text,
  version: int64,
  createdAt: zoned,
  updatedAt: zoned,
});

export const Snapshot = z.object({
  epoch: z.string(),
  seq: int64,
  serverTime: zoned,
  instruments: z.array(Instrument),
  orders: z.array(Order),
});

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), epoch: z.string(), seq: int64, serverTime: zoned }),
  z.object({ type: z.literal("heartbeat"), epoch: z.string(), seq: int64, serverTime: zoned }),
  z.object({ type: z.literal("tick"), seq: int64, instrumentId: int64, last: decimal, at: zoned }),
  z.object({ type: z.literal("order"), seq: int64, order: Order }),
]);
