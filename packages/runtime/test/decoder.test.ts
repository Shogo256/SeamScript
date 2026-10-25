import { describe, expect, it } from "vitest";
import {
  __b,
  __decode,
  __decodeJson,
  type Decimal,
  type Decoder,
  EncodeRangeError,
  type Int64,
  MAX_DEPTH,
  type ObjectDecoder,
  type Text,
  type Zoned,
} from "../src/index.js";

// The spec's example boundary, in the form the compiler emits.
type Order = {
  id: Int64;
  memo: Text<"NFC">;
  total: Decimal;
  placedAt: Zoned;
  tags?: string[];
  parent: Order | null;
};
const Order: ObjectDecoder<Order> = __b.object<Order>({
  id: __b.int64,
  memo: __b.text("NFC"),
  total: __b.decimal,
  placedAt: __b.zoned,
  tags: __b.optional(__b.array(__b.string)),
  parent: __b.nullable(__b.lazy(() => Order)),
});

const valid = {
  id: 1,
  memo: "café",
  total: "12.50",
  placedAt: "2026-10-11T22:33:16+09:00",
  tags: ["a", "b"],
  parent: null,
};

describe("object", () => {
  it("decodes the spec example and normalizes builtin types", () => {
    const r = __decode(Order, valid);
    expect(r).toEqual({
      ok: true,
      value: {
        id: 1n,
        memo: "café",
        total: "12.5",
        placedAt: "2026-10-11T22:33:16+09:00",
        tags: ["a", "b"],
        parent: null,
      },
    });
  });

  it("reports the path, the expectation and what arrived", () => {
    const r = __decode(Order, { ...valid, id: "6f1c0e3a-uuid" });
    expect(r).toEqual({
      ok: false,
      error: { kind: "decode", path: ["id"], expected: "int64", actual: "string (not a canonical int64)", rule: "value" },
    });
  });

  it("reports nested paths through recursion and arrays", () => {
    const r = __decode(Order, { ...valid, parent: { ...valid, tags: ["x", 2] } });
    expect(r.ok === false && r.error).toMatchObject({ path: ["parent", "tags", "1"], expected: "string", actual: "number" });
  });

  it("reports missing fields", () => {
    const { total: _, ...rest } = valid;
    const r = __decode(Order, rest);
    expect(r.ok === false && r.error).toMatchObject({ path: ["total"], actual: "missing", rule: "missing" });
  });

  it("drops keys that are not in the shape", () => {
    const r = __decode(Order, { ...valid, extra: true, nested: { a: 1 } });
    expect(r.ok && Object.keys(r.value)).toEqual(["id", "memo", "total", "placedAt", "tags", "parent"]);
  });

  it("lets optional keys be absent but not null", () => {
    const { tags: _, ...noTags } = valid;
    const absent = __decode(Order, noTags);
    expect(absent.ok && "tags" in absent.value).toBe(false);
    const nulled = __decode(Order, { ...valid, tags: null });
    expect(nulled.ok === false && nulled.error).toMatchObject({ path: ["tags"], expected: "string[]", actual: "null" });
  });

  it("treats an own undefined as absent for optional keys", () => {
    expect(__decode(Order, { ...valid, tags: undefined }).ok).toBe(true);
  });

  it("says null was acceptable when a nullable field mismatches", () => {
    const r = __decode(Order, { ...valid, parent: "none" });
    expect(r.ok === false && r.error).toMatchObject({ path: ["parent"], expected: "object | null", actual: "string" });
  });

  it("rejects non-objects at the top level with an empty path", () => {
    for (const [input, actual] of [
      [null, "null"],
      [[], "array"],
      ["{}", "string"],
      [undefined, "undefined"],
    ] as const) {
      expect(__decode(Order, input)).toEqual({
        ok: false,
        error: { kind: "decode", path: [], expected: "object", actual, rule: "type" },
      });
    }
  });

  it("reads own properties only", () => {
    type C = { constructor: string; toString: string };
    const C = __b.object<C>({ constructor: __b.string, toString: __b.string });
    const r = __decode(C, { toString: "x" });
    expect(r.ok === false && r.error).toMatchObject({ path: ["constructor"], actual: "missing" });
  });

  it("does not let a __proto__ key touch the prototype", () => {
    type P = { __proto__: string };
    const P = __b.object<P>({ ["__proto__"]: __b.string } as never);
    const input = JSON.parse('{"__proto__": "payload"}') as unknown;
    const r = __decode(P, input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(r.value, "__proto__")?.value).toBe("payload");
    }
    // An extra "__proto__" key on input is simply dropped.
    const extra = __decode(Order, JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(valid).slice(1)}`));
    expect(extra.ok && Object.getPrototypeOf(extra.value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("turns throwing getters into a decode failure", () => {
    const input = {
      ...valid,
      get total(): string {
        throw new Error("boom");
      },
    };
    const r = __decode(Order, input);
    expect(r.ok === false && r.error).toMatchObject({ path: ["total"], actual: "unreadable" });
  });
});

describe("decodeJson", () => {
  it("parses and decodes in one step", () => {
    expect(__decodeJson(__b.array(__b.int64), "[1, \"2\"]")).toEqual({ ok: true, value: [1n, 2n] });
    expect(Order.decodeJson(JSON.stringify(valid))).toMatchObject({ ok: true, value: { id: 1n } });
  });

  it("reports malformed JSON and non-strings as decode errors, without echoing the input", () => {
    expect(__decodeJson(__b.string, "{secret")).toEqual({
      ok: false,
      error: { kind: "decode", path: [], expected: "JSON", actual: "malformed JSON", rule: "json" },
    });
    expect(__decodeJson(__b.string, null)).toEqual({ ok: false, error: { kind: "decode", path: [], expected: "JSON text", actual: "null", rule: "type" } });
  });

  it("reports the decoded value's errors with their paths", () => {
    expect(Order.decodeJson(JSON.stringify({ ...valid, id: "x" }))).toMatchObject({ ok: false, error: { path: ["id"], expected: "int64" } });
  });
});

describe("depth limit", () => {
  // `levels` nested objects and arrays in total: each order without tags is one level.
  function chain(levels: number): unknown {
    const { tags: _, ...leaf } = valid;
    let node: unknown = null;
    for (let i = 0; i < levels; i++) node = { ...leaf, parent: node };
    return node;
  }

  it("decodes nesting up to the limit and no further", () => {
    expect(__decode(Order, chain(MAX_DEPTH)).ok).toBe(true);
    const r = __decode(Order, chain(MAX_DEPTH + 1));
    expect(r.ok === false && r.error).toMatchObject({ expected: `nesting depth <= ${MAX_DEPTH}`, actual: "deeper nesting" });
    expect(r.ok === false && r.error.path.length).toBe(MAX_DEPTH);
  });

  it("fails instead of overflowing the stack", () => {
    const r = __decode(Order, chain(100_000));
    expect(r.ok === false && r.error.expected).toBe(`nesting depth <= ${MAX_DEPTH}`);
  });

  it("stops on cyclic input (possible through postMessage)", () => {
    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.parent = cyclic;
    expect(__decode(Order, cyclic).ok).toBe(false);
  });
});

describe("primitives and builtin types as decode targets", () => {
  it("decodes arrays of builtin types", () => {
    expect(__decode(__b.array(__b.int64), [1, "2", "-3"])).toEqual({ ok: true, value: [1n, 2n, -3n] });
  });

  it("rejects non-finite numbers", () => {
    expect(__decode(__b.number, Number.NaN)).toMatchObject({ ok: false, error: { actual: "number (non-finite)" } });
    expect(__decode(__b.number, Infinity).ok).toBe(false);
    expect(__decode(__b.number, -0)).toEqual({ ok: true, value: -0 });
  });

  it("decodes boolean, null and string strictly", () => {
    expect(__decode(__b.boolean, 0).ok).toBe(false);
    expect(__decode(__b.null, undefined).ok).toBe(false);
    expect(__decode(__b.string, new String("x")).ok).toBe(false);
  });

  it("shows the received value on literal mismatches", () => {
    const status = __b.literal("paid", "open", 3);
    expect(__decode(status, "open")).toEqual({ ok: true, value: "open" });
    expect(__decode(status, 3)).toEqual({ ok: true, value: 3 });
    expect(__decode(status, "pending")).toEqual({
      ok: false,
      error: { kind: "decode", path: [], expected: '"paid" | "open" | 3', actual: '"pending"', rule: "value" },
    });
    expect(__decode(status, "3")).toMatchObject({ ok: false, error: { actual: '"3"' } });
    expect(__decode(status, "x".repeat(41))).toMatchObject({ ok: false, error: { actual: "string" } });
  });
});

describe("union", () => {
  type Paid = { kind: "paid"; amount: Decimal };
  type Refunded = { kind: "refunded" | "voided"; reason: string };
  type PaymentEvent = Paid | Refunded;
  const PaymentEvent: Decoder<PaymentEvent> = __b.union<PaymentEvent>("kind", () => [Paid, Refunded]);
  const Paid: ObjectDecoder<Paid> = __b.object<Paid>({ kind: __b.literal("paid"), amount: __b.decimal });
  const Refunded: ObjectDecoder<Refunded> = __b.object<Refunded>({
    kind: __b.literal("refunded", "voided"),
    reason: __b.string,
  });

  it("dispatches on the discriminant", () => {
    expect(__decode(PaymentEvent, { kind: "paid", amount: "1.0" })).toEqual({
      ok: true,
      value: { kind: "paid", amount: "1" },
    });
    expect(__decode(PaymentEvent, { kind: "voided", reason: "dup" })).toEqual({
      ok: true,
      value: { kind: "voided", reason: "dup" },
    });
  });

  it("reports unknown and missing discriminants at the discriminant's path", () => {
    expect(__decode(PaymentEvent, { kind: "chargeback" })).toEqual({
      ok: false,
      error: { kind: "decode", path: ["kind"], expected: '"paid" | "refunded" | "voided"', actual: '"chargeback"', rule: "value" },
    });
    expect(__decode(PaymentEvent, {})).toMatchObject({ ok: false, error: { path: ["kind"], actual: "missing", rule: "missing" } });
  });

  it("reports member field errors under the member's paths", () => {
    expect(__decode(PaymentEvent, { kind: "paid", amount: 1 })).toMatchObject({
      ok: false,
      error: { path: ["amount"], expected: "decimal", actual: "number" },
    });
  });

  it("encodes through the matching member", () => {
    expect(PaymentEvent.encode({ kind: "refunded", reason: "r", extra: 1 } as Refunded)).toEqual({
      kind: "refunded",
      reason: "r",
    });
  });

  it("finds the discriminant itself when no key is given", () => {
    type Up = { dir: "up"; kind: "move"; n: number };
    type Down = { dir: "down"; kind: "move"; n: number };
    const Up = __b.object<Up>({ dir: __b.literal("up"), kind: __b.literal("move"), n: __b.number });
    const Down = __b.object<Down>({ dir: __b.literal("down"), kind: __b.literal("move"), n: __b.number });
    // "kind" is a literal in both but shares its value, so "dir" is chosen.
    const Move = __b.union<Up | Down>(() => [Up, Down]);
    expect(Move.encode({ dir: "down", kind: "move", n: 1 })).toEqual({ dir: "down", kind: "move", n: 1 });
    expect(__decode(Move, { dir: "up", kind: "move", n: 1 })).toEqual({ ok: true, value: { dir: "up", kind: "move", n: 1 } });
    expect(__decode(Move, { dir: "left", kind: "move", n: 1 })).toMatchObject({
      ok: false,
      error: { path: ["dir"], expected: '"up" | "down"', actual: '"left"' },
    });
  });

  it("rejects members without a usable discriminant when first used", () => {
    const A = __b.object<{ a: string }>({ a: __b.string });
    const B = __b.object<{ b: string }>({ b: __b.string });
    expect(() => __decode(__b.union<{ a: string } | { b: string }>(() => [A, B]), {})).toThrow(TypeError);
  });

  it("rejects overlapping members when first used", () => {
    const A = __b.object<{ t: "a" }>({ t: __b.literal("a") });
    const B = __b.object<{ t: "a" | "b" }>({ t: __b.literal("a", "b") });
    const AB = __b.union<{ t: "a" } | { t: "a" | "b" }>("t", () => [A, B]);
    expect(() => __decode(AB, { t: "a" })).toThrow(TypeError);
  });
});

describe("encode", () => {
  const order: Order = {
    id: 9_007_199_254_740_993n,
    memo: "café" as Text<"NFC">,
    total: "12.5" as Decimal,
    placedAt: "2026-10-11T22:33:16+09:00" as Zoned,
    parent: {
      id: -1n,
      memo: "" as Text<"NFC">,
      total: "0" as Decimal,
      placedAt: "2026-01-01T00:00:00Z" as Zoned,
      tags: [],
      parent: null,
    },
  };

  it("produces JSON-ready values that decode back to the same thing", () => {
    const encoded = Order.encode(order);
    expect(encoded.id).toBe("9007199254740993");
    expect("tags" in encoded).toBe(false);
    const back = __decode(Order, JSON.parse(JSON.stringify(encoded)));
    expect(back).toEqual({ ok: true, value: order });
  });

  it("only writes declared keys", () => {
    const withExtra = { ...order, secret: "x" } as Order;
    expect(Object.keys(Order.encode(withExtra))).not.toContain("secret");
  });

  it("throws EncodeRangeError with a path when an Int64 left the 64-bit range", () => {
    const overflow: Order = { ...order, parent: { ...order.parent!, id: 2n ** 63n } };
    let caught: unknown;
    try {
      Order.encode(overflow);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EncodeRangeError);
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as EncodeRangeError).path).toEqual(["parent", "id"]);
    expect((caught as EncodeRangeError).message).toBe('Int64 out of range at ["parent","id"]');
  });
});

describe("constraints", () => {
  type Account = { handle: string; name: Text<"NFC">; port: number; quota: Int64; tags: string[]; nick: Text<"NFC"> | null };
  const Account: ObjectDecoder<Account> = __b.object<Account>({
    handle: __b.matches(__b.string, /^[a-z][a-z0-9_]*$/),
    name: __b.length(__b.matches(__b.text("NFC"), /\S/), 1, 5),
    port: __b.range(__b.number, 1, 65535),
    quota: __b.range(__b.int64, 0n, 1_000_000_000_000n),
    tags: __b.length(__b.array(__b.string), 0, 2),
    nick: __b.nullable(__b.length(__b.text("NFC"), 1)),
  });
  const good = { handle: "ada_1", name: "Ada", port: 443, quota: "5", tags: ["x"], nick: null };
  const failure = (patch: object) => {
    const r = Account.decode({ ...good, ...patch });
    return r.ok ? undefined : r.error;
  };

  it("accepts values inside every constraint", () => {
    expect(Account.decode(good)).toEqual({ ok: true, value: { ...good, quota: 5n } });
    expect(Account.decode({ ...good, port: 65535, tags: [], nick: "x" }).ok).toBe(true);
  });

  it("reports the field, the constraint and what was wrong, never the value", () => {
    expect(failure({ handle: "Ada" })).toEqual({ kind: "decode", path: ["handle"], expected: "string matching /^[a-z][a-z0-9_]*$/", actual: "string (no match)", rule: "pattern" });
    expect(failure({ port: 0 })).toEqual({ kind: "decode", path: ["port"], expected: "number in 1..65535", actual: "number (out of range)", rule: "range" });
    expect(failure({ quota: "-1" })).toMatchObject({ path: ["quota"], expected: "int64 in 0..1000000000000", actual: "int64 (out of range)" });
    expect(failure({ tags: ["a", "b", "c"] })).toMatchObject({ path: ["tags"], expected: "string[] of length 2 or less", actual: "length 3" });
    expect(failure({ nick: "" })).toMatchObject({ path: ["nick"], expected: "text of length 1 or more | null", actual: "length 0" });
  });

  it("measures Text in grapheme clusters, after normalization", () => {
    // Five clusters, nine code units: a family emoji, e + combining acute (NFC: é), and three letters.
    expect(failure({ name: "\u{1F468}‍\u{1F469}‍\u{1F467}éabc" })).toBeUndefined();
    expect(failure({ name: "abcdef" })).toMatchObject({ expected: "text matching /\\S/ of length 1..5", actual: "length 6" });
    // The whole field's expectation, whichever of its constraints failed.
    expect(failure({ name: "   " })).toMatchObject({ expected: "text matching /\\S/ of length 1..5", actual: "text (no match)" });
  });

  it("reports a type mismatch with the constrained expectation", () => {
    expect(failure({ port: "443" })).toMatchObject({ expected: "number in 1..65535", actual: "string" });
    expect(failure({ nick: 3 })).toMatchObject({ expected: "text of length 1 or more | null", actual: "number" });
  });

  it("ignores a pattern's global and sticky flags, which would make test() stateful", () => {
    const d = __b.matches(__b.string, /a/gy);
    expect([d.decode("a").ok, d.decode("a").ok, d.decode("a").ok]).toEqual([true, true, true]);
  });

  it("refuses to encode a value that would not decode again", () => {
    const value = { ...good, name: "Ada" as Text<"NFC">, quota: 5n };
    expect(() => Account.encode({ ...value, port: 70000 })).toThrow(EncodeRangeError);
    let caught: unknown;
    try {
      Account.encode({ ...value, tags: ["a", "b", "c"] });
    } catch (e) {
      caught = e;
    }
    expect((caught as EncodeRangeError).path).toEqual(["tags"]);
    expect((caught as Error).message).toBe('Expected string[] of length 2 or less, got length 3 at ["tags"]');
    expect(Account.encode(value)).toEqual({ ...good, quota: "5" });
  });
});
