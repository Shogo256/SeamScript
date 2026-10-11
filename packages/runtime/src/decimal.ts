import type { Brand } from "./brand.js";

/**
 * A decimal number kept as its canonical string: no leading zeros, no trailing
 * fraction zeros, no negative zero. `"12.50"` and `"12.5"` are both stored as
 * `"12.5"`, so `===` compares values.
 */
export type Decimal = string & Brand<"Decimal">;

const SYNTAX = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export function normalizeDecimal(s: string): Decimal | undefined {
  const m = SYNTAX.exec(s);
  if (m === null) return undefined;
  const int = m[2]!;
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const body = frac === "" ? int : `${int}.${frac}`;
  if (body === "0") return "0" as Decimal;
  return (m[1] + body) as Decimal;
}

type Parts = { neg: boolean; int: string; frac: string };

function parts(d: Decimal): Parts {
  const neg = d.startsWith("-");
  const body = neg ? d.slice(1) : d;
  const dot = body.indexOf(".");
  return dot < 0
    ? { neg, int: body, frac: "" }
    : { neg, int: body.slice(0, dot), frac: body.slice(dot + 1) };
}

function compareMagnitude(a: Parts, b: Parts): -1 | 0 | 1 {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const width = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(width, "0");
  const fb = b.frac.padEnd(width, "0");
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
}

function preview(s: string): string {
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
}

export const Decimal = {
  /**
   * For values written in the program. Untrusted strings go through `decode`,
   * which reports failure as a value instead of throwing.
   */
  from(value: string | bigint): Decimal {
    if (typeof value === "bigint") return value.toString() as Decimal;
    const d = normalizeDecimal(value);
    if (d === undefined) throw new SyntaxError(`Invalid Decimal: ${preview(value)}`);
    return d;
  },

  compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
    if (a === b) return 0;
    const pa = parts(a);
    const pb = parts(b);
    if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
    const m = compareMagnitude(pa, pb);
    return pa.neg ? ((-m) as -1 | 0 | 1) : m;
  },

  /**
   * Fixed-point display string. Rounds half away from zero (the `Intl.NumberFormat`
   * default) and never prints a negative zero.
   */
  toFixed(d: Decimal, digits: number): string {
    if (!Number.isInteger(digits) || digits < 0 || digits > 100) {
      throw new RangeError(`toFixed() digits must be an integer from 0 to 100, got ${digits}`);
    }
    const { neg, int, frac } = parts(d);
    if (frac.length <= digits) {
      const tail = digits === 0 ? "" : `.${frac.padEnd(digits, "0")}`;
      return `${neg ? "-" : ""}${int}${tail}`;
    }
    let scaled = BigInt(int + frac.slice(0, digits));
    if (frac.charCodeAt(digits) >= 0x35 /* '5' */) scaled += 1n;
    const s = scaled.toString().padStart(digits + 1, "0");
    const intPart = s.slice(0, s.length - digits);
    const tail = digits === 0 ? "" : `.${s.slice(s.length - digits)}`;
    return `${neg && scaled !== 0n ? "-" : ""}${intPart}${tail}`;
  },
} as const;
