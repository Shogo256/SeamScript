import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  __b,
  __decode,
  __latest,
  Decimal,
  type Decoder,
  err,
  Int64,
  type ObjectDecoder,
  ok,
  type Result,
  Text,
  type TextForm,
  Zoned,
} from "../src/index.js";

// --- decoders under test -------------------------------------------------------

type Order = {
  id: Int64;
  memo: Text<"NFC">;
  total: Decimal;
  placedAt: Zoned;
  status: "paid" | "open" | 3;
  tags?: string[];
  parent: Order | null;
};
const Order: ObjectDecoder<Order> = __b.object<Order>({
  id: __b.int64,
  memo: __b.text("NFC"),
  total: __b.decimal,
  placedAt: __b.zoned,
  status: __b.literal("paid", "open", 3),
  tags: __b.optional(__b.array(__b.string)),
  parent: __b.nullable(__b.lazy(() => Order)),
});

type Paid = { kind: "paid"; amount: Decimal };
type Refunded = { kind: "refunded"; reason: Text<"NFD"> | null };
const Paid: ObjectDecoder<Paid> = __b.object<Paid>({ kind: __b.literal("paid"), amount: __b.decimal });
const Refunded: ObjectDecoder<Refunded> = __b.object<Refunded>({
  kind: __b.literal("refunded"),
  reason: __b.nullable(__b.text("NFD")),
});
const PaymentEvent = __b.union<Paid | Refunded>("kind", () => [Paid, Refunded]);

const decoders: [string, Decoder<unknown>][] = [
  ["Order", Order],
  ["PaymentEvent", PaymentEvent],
  ["Order[]", __b.array(Order)],
  ["int64", __b.int64],
  ["decimal", __b.decimal],
  ["zoned", __b.zoned],
  ["text", __b.text("NFC")],
  ["number", __b.number],
  ["literal", __b.literal("a", 1)],
];

const anything = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withObjectString: true,
  withSparseArray: true,
  withTypedArray: true,
  withUnicodeString: true,
});

// Objects with the right keys but arbitrary values reach the per-field code paths.
const orderShaped: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  order: fc.record(
    {
      id: fc.oneof(anything, fc.bigInt(), fc.integer(), fc.string()),
      memo: fc.oneof(anything, fc.string({ unit: "binary" })),
      total: fc.oneof(anything, fc.string()),
      placedAt: fc.oneof(anything, fc.string()),
      status: fc.oneof(anything, fc.constantFrom("paid", "open", 3, "3")),
      tags: fc.oneof(anything, fc.array(anything)),
      parent: fc.oneof({ depthSize: "small" }, fc.constant(null), anything, tie("order")),
      kind: fc.constantFrom("paid", "refunded", "other"),
      amount: anything,
      reason: anything,
    },
    { requiredKeys: [] },
  ),
})).order;

describe("decode never throws on bad data", () => {
  it.each(decoders)("%s", (_, d) => {
    fc.assert(
      fc.property(fc.oneof(anything, orderShaped), (input) => {
        const r = d.decode(input);
        expect(typeof r.ok).toBe("boolean");
        if (!r.ok) expect(r.error.kind).toBe("decode");
      }),
      { numRuns: 300 },
    );
  });
});

// --- valid values and round trips ---------------------------------------------------

const decimalString = fc
  .tuple(
    fc.boolean(),
    fc.oneof(fc.constant("0"), fc.stringMatching(/^[1-9][0-9]{0,20}$/)),
    fc.option(fc.stringMatching(/^[0-9]{1,20}$/), { nil: undefined }),
  )
  .map(([neg, int, frac]) => `${neg ? "-" : ""}${int}${frac === undefined ? "" : `.${frac}`}`);

const pad = (n: number, w: number) => String(n).padStart(w, "0");

const zonedParts = fc
  .record({
    year: fc.integer({ min: 0, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    dayFrac: fc.double({ min: 0, max: 0.999999, noNaN: true }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    fraction: fc.stringMatching(/^[0-9]{0,9}$/),
    offset: fc.oneof(fc.constant("Z"), fc.constant("z"), fc.integer({ min: -(23 * 60 + 59), max: 23 * 60 + 59 }).filter((m) => m !== 0)),
  })
  .map((p) => {
    const dim = new Date(Date.UTC(2000, p.month, 0)).getUTCDate();
    const days = p.month === 2 ? ((p.year % 4 === 0 && p.year % 100 !== 0) || p.year % 400 === 0 ? 29 : 28) : dim;
    const day = 1 + Math.floor(p.dayFrac * days);
    const off =
      typeof p.offset === "string"
        ? p.offset
        : `${p.offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(p.offset) / 60), 2)}:${pad(Math.abs(p.offset) % 60, 2)}`;
    const date = `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(day, 2)}`;
    const time = `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
    return { date, time, fraction: p.fraction, off };
  });

const zonedString = zonedParts.map((p) => `${p.date}T${p.time}${p.fraction ? `.${p.fraction}` : ""}${p.off}`);

const validOrder: fc.Arbitrary<Order> = fc.letrec((tie) => ({
  order: fc.record(
    {
      id: fc.bigInt({ min: Int64.MIN, max: Int64.MAX }),
      memo: fc.string({ unit: "binary" }).map((s) => Text.nfc(s)),
      total: decimalString.map(Decimal.from),
      placedAt: zonedString.map(Zoned.from),
      status: fc.constantFrom("paid" as const, "open" as const, 3 as const),
      tags: fc.array(fc.string()),
      parent: fc.oneof({ depthSize: "small" }, fc.constant(null), tie("order") as fc.Arbitrary<Order>),
    },
    { requiredKeys: ["id", "memo", "total", "placedAt", "status", "parent"] },
  ),
})).order as fc.Arbitrary<Order>;

describe("encode / decode round trip", () => {
  it("survives JSON.stringify and decodes to the same value", () => {
    fc.assert(
      fc.property(validOrder, (order) => {
        const json = JSON.stringify(Order.encode(order));
        expect(__decode(Order, JSON.parse(json))).toEqual({ ok: true, value: order });
      }),
    );
  });
});

// --- Decimal against BigInt and Intl references ---------------------------------------

function scaled(d: string, scale: number): bigint {
  const neg = d.startsWith("-");
  const [i, f = ""] = (neg ? d.slice(1) : d).split(".");
  const v = BigInt(i! + f.padEnd(scale, "0"));
  return neg ? -v : v;
}

describe("Decimal", () => {
  it("normalization is idempotent and keeps the value", () => {
    fc.assert(
      fc.property(decimalString, (s) => {
        const d = Decimal.from(s);
        expect(Decimal.from(d)).toBe(d);
        expect(scaled(d, 25)).toBe(scaled(s, 25));
      }),
    );
  });

  it("compare matches exact arithmetic and === means equal value", () => {
    fc.assert(
      fc.property(decimalString, decimalString, (a, b) => {
        const x = scaled(a, 25);
        const y = scaled(b, 25);
        const da = Decimal.from(a);
        const db = Decimal.from(b);
        expect(Decimal.compare(da, db)).toBe(x === y ? 0 : x < y ? -1 : 1);
        expect(da === db).toBe(x === y);
      }),
    );
  });

  it("toFixed matches Intl.NumberFormat with halfExpand rounding", () => {
    fc.assert(
      fc.property(decimalString, fc.integer({ min: 0, max: 25 }), (s, digits) => {
        const reference = new Intl.NumberFormat("en-US", {
          useGrouping: false,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
          roundingMode: "halfExpand",
          signDisplay: "negative",
        }).format(s as Intl.StringNumericLiteral);
        expect(Decimal.toFixed(Decimal.from(s), digits)).toBe(reference);
      }),
    );
  });
});

// --- Zoned against Date -------------------------------------------------------------

describe("Zoned", () => {
  it("normalization is idempotent", () => {
    fc.assert(
      fc.property(zonedString, (s) => {
        const z = Zoned.from(s);
        expect(Zoned.from(z)).toBe(z);
        expect(Zoned.sameInstant(z, Zoned.from(s))).toBe(true);
      }),
    );
  });

  it("agrees with Date.parse at millisecond precision and round-trips through Date", () => {
    fc.assert(
      fc.property(
        zonedParts.filter((p) => p.fraction.length <= 3),
        (p) => {
          const iso = `${p.date}T${p.time}.${p.fraction.padEnd(3, "0")}${p.off.toUpperCase()}`;
          const z = Zoned.from(iso);
          expect(Zoned.epochNanoseconds(z)).toBe(BigInt(Date.parse(iso)) * 1_000_000n);
          expect(Zoned.fromDate(Zoned.toDate(z), Zoned.offsetMinutes(z))).toBe(z);
        },
      ),
    );
  });
});

// --- Text -------------------------------------------------------------------------------

// Characters chosen to stress normalization and segmentation together: combining marks
// with different combining classes, Hangul jamo, ZWJ emoji, skin tones, flags,
// Devanagari conjuncts, Tibetan vowel signs, compatibility and singleton decompositions.
const pool = [
  "a", "e", "u", "A", " ", "\r", "\n", "́", "̈", "̄", "̖", "̣", "ͅ",
  "ᄀ", "ᅡ", "ᆨ", "가", "‍", "\u{1F468}", "\u{1F469}", "\u{1F466}", "\u{1F3FB}",
  "\u{1F1EF}", "\u{1F1F5}", "क", "्", "ष", "é", "ǖ", "ཱ", "ི", "ྀ",
  "Å", "Å", "ẛ", "̈́", "क़",
];
const stress = fc.array(fc.constantFrom(...pool), { maxLength: 12 }).map((a) => a.join(""));
const anyText = fc.oneof(stress, fc.string({ unit: "binary", maxLength: 12 }));
const forms: TextForm[] = ["NFC", "NFD"];

describe("Text", () => {
  it.each(forms)("%s: construction is idempotent", (f) => {
    const make = f === "NFC" ? Text.nfc : Text.nfd;
    fc.assert(
      fc.property(anyText, (s) => {
        const t = make(s);
        expect(make(t)).toBe(t);
        expect(t.normalize(f)).toBe(t);
      }),
    );
  });

  it.each(forms)("%s: every grapheme-aligned slice is still normalized", (f) => {
    const make = f === "NFC" ? Text.nfc : Text.nfd;
    fc.assert(
      fc.property(anyText, (s) => {
        const t = make(s);
        const n = Text.length(t);
        for (let i = 0; i <= n; i++) {
          for (let j = i; j <= n; j++) {
            const piece = Text.slice(t, i, j);
            expect(piece.normalize(f), JSON.stringify([s, i, j])).toBe(piece);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("slices, graphemes and at agree and reassemble the original", () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: -15, max: 15 }), (s, k) => {
        const t = Text.nfc(s);
        const gs = Text.graphemes(t);
        expect(gs.join("")).toBe(t);
        expect(Text.length(t)).toBe(gs.length);
        expect(Text.slice(t, 0, k) + Text.slice(t, k)).toBe(t);
        expect(Text.at(t, k)).toBe(gs.at(k));
      }),
    );
  });
});

// --- latest against a model ---------------------------------------------------------------

type Action = { kind: "call" } | { kind: "cancel" } | { kind: "settle"; pick: number; outcome: "ok" | "err" | "throw" };
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "call" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "cancel" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("settle" as const),
      pick: fc.nat(),
      outcome: fc.constantFrom("ok" as const, "err" as const, "throw" as const),
    }),
  },
);

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("latest", () => {
  // Model: when call i settles, it delivers its own outcome iff it is the newest call
  // and the line has not been cancelled since it started; otherwise it is Stale.
  // Every call settles exactly once, and nothing rejects except a delivered "throw".
  it("matches the generation model for any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 25 }), async (actions) => {
        const pending: { resolve: (r: Result<number, string>) => void; reject: (e: unknown) => void }[] = [];
        const line = __latest(
          (id: number) =>
            new Promise<Result<number, string>>((resolve, reject) => {
              pending[id] = { resolve, reject };
            }),
        ).fork();

        const observed: string[] = [];
        const expected: string[] = [];
        const open = new Set<number>();
        let calls = 0;
        let newest = -1;
        let cancelledThrough = -1;

        const settle = async (id: number, outcome: "ok" | "err" | "throw") => {
          open.delete(id);
          expected[id] = id === newest && id > cancelledThrough ? outcome : "stale";
          if (outcome === "ok") pending[id]!.resolve(ok(id));
          else if (outcome === "err") pending[id]!.resolve(err("e"));
          else pending[id]!.reject(new Error("thrown"));
          await flush();
        };

        for (const a of actions) {
          if (a.kind === "call") {
            const id = calls++;
            newest = id;
            open.add(id);
            line(id).then(
              (r) => (observed[id] = r.ok ? "ok" : r.error === "e" ? "err" : "stale"),
              () => (observed[id] = "throw"),
            );
            await flush();
          } else if (a.kind === "cancel") {
            line.cancel();
            cancelledThrough = calls - 1;
          } else if (open.size > 0) {
            const ids = [...open];
            await settle(ids[a.pick % ids.length]!, a.outcome);
          }
        }
        for (const id of [...open]) await settle(id, "ok");

        expect(observed).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });
});
