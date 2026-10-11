// Type-level tests: compiled by `tsc --noEmit` (part of `yarn test`), never executed.
// Every `@ts-expect-error` must hit an error, so each one is an assertion.
import {
  __b,
  __decode,
  __latest,
  type Decimal,
  type Decoder,
  type Int64,
  type ObjectDecoder,
  ok,
  err,
  type Text,
  type Unknown,
  type Zoned,
  Text as TextNs,
} from "../src/index.js";

declare const v: Unknown;

// --- boundary, written the way the compiler emits it -------------------------
// The const carries an explicit type: without it a recursive boundary
// (`__b.lazy(() => Order)`) is TS7022, "referenced in its own initializer".

type Order = {
  id: Int64;
  memo: Text<"NFC">;
  total: Decimal;
  placedAt: Zoned;
  status: "paid" | "open";
  tags?: string[];
  parent: Order | null;
};
const Order: ObjectDecoder<Order> = __b.object<Order>({
  id: __b.int64,
  memo: __b.text("NFC"),
  total: __b.decimal,
  placedAt: __b.zoned,
  status: __b.literal("paid", "open"),
  tags: __b.optional(__b.array(__b.string)),
  parent: __b.nullable(__b.lazy(() => Order)),
});

__b.object<{ a: string }>({
  // @ts-expect-error wrong decoder for the field
  a: __b.number,
});

// @ts-expect-error missing field decoder
__b.object<{ a: string; b: number }>({ a: __b.string });

__b.object<{ a?: string }>({
  // @ts-expect-error optional field needs __b.optional
  a: __b.string,
});

__b.object<{ a: "x" | "y" }>({
  // @ts-expect-error literal set must match
  a: __b.literal("x", "z"),
});

// --- decode result -----------------------------------------------------------

const r = __decode(Order, v);
// @ts-expect-error value is not readable before checking ok
r.value;
if (r.ok) {
  const id: bigint = r.value.id;
  const status: "paid" | "open" = r.value.status;
  const parentId: bigint | undefined = r.value.parent?.id;
  void [id, status, parentId];
} else {
  const path: string[] = r.error.path;
  void path;
}

// --- encode ------------------------------------------------------------------

declare const order: Order;
const e = Order.encode(order);
const encodedId: string = e.id;
const encodedMemo: string = e.memo;
const encodedStatus: "paid" | "open" = e.status;
const encodedParent: string | undefined = e.parent?.id;
void [encodedId, encodedMemo, encodedStatus, encodedParent];

// --- discriminated union -----------------------------------------------------

type Paid = { kind: "paid"; amount: Decimal };
type Refunded = { kind: "refunded"; reason: string };
type PaymentEvent = Paid | Refunded;
const PaymentEvent: Decoder<PaymentEvent> = __b.union<PaymentEvent>("kind", () => [Paid, Refunded]);
const Paid: ObjectDecoder<Paid> = __b.object<Paid>({ kind: __b.literal("paid"), amount: __b.decimal });
const Refunded: ObjectDecoder<Refunded> = __b.object<Refunded>({ kind: __b.literal("refunded"), reason: __b.string });
const ev = __decode(PaymentEvent, v);
if (ev.ok && ev.value.kind === "paid") {
  const amount: Decimal = ev.value.amount;
  void amount;
}

// --- Unknown -----------------------------------------------------------------

// @ts-expect-error no properties
v.id;
// @ts-expect-error no `as` to a primitive
void (v as string);
// @ts-expect-error no `as` to a boundary type
void (v as Order);
// @ts-expect-error not assignable to Text
const notText: Text<"NFC"> = v;

// --- Text ----------------------------------------------------------------------

declare const t: Text<"NFC">;
declare const d: Text<"NFD">;

const plain: string = t; // widening to string is allowed: libraries accept Text as-is
const templated = `${t}!`;
const joined: string = t + "x"; // plain string again
void [plain, templated, joined, notText];

// @ts-expect-error code-unit slicing
t.slice(0, 10);
// @ts-expect-error code-unit access
t.charAt(0);
// @ts-expect-error code-unit search
t.indexOf("a");
// @ts-expect-error code-point iteration splits emoji sequences
for (const c of t) void c;
// @ts-expect-error spreading iterates code points too
void [...t];

// Reads below type-check as `never`; TypeScript cannot reject them, the checker pass does.
const unitLength: number = t.length;
const unit = t[0];
void [unitLength, unit];

// @ts-expect-error NFC and NFD are different types
const mixed: Text<"NFC"> = d;
// @ts-expect-error comparing NFC with NFD is a type error
void (t === d);
void mixed;

// @ts-expect-error a plain string is not Text
const fromString: Text<"NFC"> = "abc";
void fromString;

const sliced: Text<"NFC"> = TextNs.slice(t, 0, 10);
const nfdAt: Text<"NFD"> | undefined = TextNs.at(d, -1);
void [sliced, nfdAt];

// --- latest --------------------------------------------------------------------

const search = __latest(async (q: string) => (q ? ok(q.length) : err({ kind: "empty" as const })));
async function useSearch() {
  const res = await search("abc");
  if (res.ok) {
    const n: number = res.value;
    void n;
  } else if (res.error.kind === "stale") {
    return;
  } else {
    const kind: "empty" = res.error.kind;
    void kind;
  }
}
void useSearch;

const withSignal = __latest(async (q: string, signal: AbortSignal) => ok(signal.aborted ? q : ""), { signal: 1 });
void withSignal("q");
// @ts-expect-error the signal is supplied by the wrapper, not the caller
void withSignal("q", new AbortController().signal);

const forked = search.fork();
forked.cancel();
// @ts-expect-error only forks can be cancelled
search.cancel();

// @ts-expect-error latest functions must return a Result
__latest(async () => 1);
