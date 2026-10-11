import { describe, expect, it } from "vitest";
import { __b, __decode, Decimal, Int64, Zoned } from "../src/index.js";

describe("Int64", () => {
  const decode = (v: unknown) => __decode(__b.int64, v);

  it("accepts safe-integer numbers and canonical digit strings", () => {
    expect(decode(42)).toEqual({ ok: true, value: 42n });
    expect(decode(-0)).toEqual({ ok: true, value: 0n });
    expect(decode("9223372036854775807")).toEqual({ ok: true, value: Int64.MAX });
    expect(decode("-9223372036854775808")).toEqual({ ok: true, value: Int64.MIN });
  });

  it("rejects numbers that may already have lost precision in JSON.parse", () => {
    expect(decode(2 ** 53)).toMatchObject({ ok: false, error: { actual: "number (unsafe integer)" } });
    expect(decode(1.5)).toMatchObject({ ok: false, error: { actual: "number (not an integer)" } });
  });

  it("rejects strings that are not canonical integers or are out of range", () => {
    for (const s of ["", "+1", "-0", "007", "1e3", " 1", "1.0", "9223372036854775808", "-9223372036854775809", "1".repeat(30)]) {
      expect(decode(s), s).toMatchObject({ ok: false, error: { expected: "int64" } });
    }
  });

  it("encodes to a digit string", () => {
    expect(__b.int64.encode(-5n)).toBe("-5");
  });
});

describe("Decimal", () => {
  const decode = (v: unknown) => __decode(__b.decimal, v);

  it("normalizes so that === compares values", () => {
    expect(decode("12.50")).toEqual({ ok: true, value: "12.5" });
    expect(decode("12.0")).toEqual({ ok: true, value: "12" });
    expect(decode("-0.000")).toEqual({ ok: true, value: "0" });
    expect(decode("0.10")).toEqual({ ok: true, value: "0.1" });
  });

  it("accepts strings only, in plain decimal notation", () => {
    expect(decode(12.5)).toMatchObject({ ok: false, error: { actual: "number" } });
    for (const s of ["", ".5", "5.", "+1", "01", "1e3", "1,5", " 1"]) {
      expect(decode(s), s).toMatchObject({ ok: false, error: { expected: "decimal" } });
    }
  });

  it("compares by value", () => {
    const d = Decimal.from;
    expect(Decimal.compare(d("12.5"), d("12.50"))).toBe(0);
    expect(Decimal.compare(d("9.99"), d("10"))).toBe(-1);
    expect(Decimal.compare(d("-1"), d("-0.5"))).toBe(-1);
    expect(Decimal.compare(d("-0.5"), d("0"))).toBe(-1);
    expect(Decimal.compare(d("0.12"), d("0.112"))).toBe(1);
  });

  it("formats with a fixed number of digits, rounding half away from zero", () => {
    const d = Decimal.from;
    expect(Decimal.toFixed(d("12.50"), 2)).toBe("12.50");
    expect(Decimal.toFixed(d("12"), 2)).toBe("12.00");
    expect(Decimal.toFixed(d("1.005"), 2)).toBe("1.01");
    expect(Decimal.toFixed(d("-1.005"), 2)).toBe("-1.01");
    expect(Decimal.toFixed(d("9.995"), 2)).toBe("10.00");
    expect(Decimal.toFixed(d("0.4"), 0)).toBe("0");
    expect(Decimal.toFixed(d("-0.001"), 2)).toBe("0.00");
    expect(() => Decimal.toFixed(d("1"), -1)).toThrow(RangeError);
  });

  it("constructs from program values and throws on malformed literals", () => {
    expect(Decimal.from(-12n)).toBe("-12");
    expect(Decimal.from("3.140")).toBe("3.14");
    expect(() => Decimal.from("3,14")).toThrow(SyntaxError);
  });
});

describe("Zoned", () => {
  const decode = (v: unknown) => __decode(__b.zoned, v);

  it("normalizes to a canonical form", () => {
    expect(decode("2026-10-11T22:33:16+09:00")).toEqual({ ok: true, value: "2026-10-11T22:33:16+09:00" });
    expect(decode("2026-10-11t13:33:16.500z")).toEqual({ ok: true, value: "2026-10-11T13:33:16.5Z" });
    expect(decode("2026-10-11T13:33+00:00")).toEqual({ ok: true, value: "2026-10-11T13:33:00Z" });
    expect(decode("2026-10-11T13:33:16,000000001-05:30")).toEqual({
      ok: true,
      value: "2026-10-11T13:33:16.000000001-05:30",
    });
  });

  it("requires an offset and a real calendar date", () => {
    for (const s of [
      "2026-10-11T13:33:16", // no offset
      "2026-10-11T13:33:16-00:00", // RFC 3339 "unknown offset"
      "2026-02-29T00:00:00Z", // not a leap year
      "2026-13-01T00:00:00Z",
      "2026-10-11T24:00:00Z",
      "2026-10-11T23:59:60Z",
      "2026-10-11 13:33:16Z",
      "2026-10-11T13:33:16.1234567890Z",
      "2026-10-11T13:33:16+0900",
    ]) {
      expect(decode(s), s).toMatchObject({ ok: false, error: { expected: "zoned" } });
    }
    expect(decode("2024-02-29T00:00:00Z").ok).toBe(true);
  });

  it("distinguishes same instant from same value", () => {
    const a = Zoned.from("2026-10-11T22:33:16+09:00");
    const b = Zoned.from("2026-10-11T13:33:16Z");
    expect(a === b).toBe(false);
    expect(Zoned.sameInstant(a, b)).toBe(true);
    expect(Zoned.compare(a, b)).toBe(0);
    expect(Zoned.compare(a, Zoned.from("2026-10-11T13:33:16.000000001Z"))).toBe(-1);
  });

  it("agrees with Date on the instant", () => {
    for (const s of ["2026-10-11T22:33:16.123+09:00", "1969-12-31T23:59:59.999Z", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59-23:59"]) {
      const z = Zoned.from(s);
      expect(Zoned.toDate(z).getTime(), s).toBe(Date.parse(s));
      expect(Zoned.epochNanoseconds(z)).toBe(BigInt(Date.parse(s)) * 1_000_000n);
    }
  });

  it("truncates toward the past when converting to Date", () => {
    expect(Zoned.toDate(Zoned.from("1969-12-31T23:59:59.9999Z")).toISOString()).toBe("1969-12-31T23:59:59.999Z");
  });

  it("builds from a Date in a given offset", () => {
    const date = new Date("2026-10-11T13:33:16.120Z");
    expect(Zoned.fromDate(date, 9 * 60)).toBe("2026-10-11T22:33:16.12+09:00");
    expect(Zoned.fromDate(date, 0)).toBe("2026-10-11T13:33:16.12Z");
    expect(Zoned.offsetMinutes(Zoned.fromDate(date, -330))).toBe(-330);
    expect(() => Zoned.fromDate(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => Zoned.fromDate(date, 24 * 60)).toThrow(RangeError);
    expect(() => Zoned.fromDate(new Date(8.64e15), 60)).toThrow(RangeError);
  });
});
