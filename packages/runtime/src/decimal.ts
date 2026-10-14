import type { Brand } from "./brand.js";

/**
 * A decimal number kept as its canonical string: no leading zeros, no trailing
 * fraction zeros, no negative zero. `"12.50"` and `"12.5"` are both stored as
 * `"12.5"`, so `===` compares values.
 */
export type Decimal = string & Brand<"Decimal">;

const SYNTAX = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Whether `s` is already canonical: what servers send, checked without the regular expression. */
function isCanonical(s: string): boolean {
  const n = s.length;
  let i = s.charCodeAt(0) === 0x2d ? 1 : 0;
  const start = i;
  while (i < n && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) i++;
  const intLength = i - start;
  // No leading zero, and no integer part made of a leading zero alone unless it is "0".
  if (intLength === 0 || (intLength > 1 && s.charCodeAt(start) === 0x30)) return false;
  if (i === n) return !(start === 1 && intLength === 1 && s.charCodeAt(1) === 0x30); // "-0"
  if (s.charCodeAt(i) !== 0x2e) return false;
  const dot = ++i;
  while (i < n && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) i++;
  // At least one fraction digit, the last not a zero, so "-0.x" is never zero.
  return i === n && i > dot && s.charCodeAt(n - 1) !== 0x30;
}

export function normalizeDecimal(s: string): Decimal | undefined {
  return isCanonical(s) ? (s as Decimal) : normalizeDecimalByPattern(s);
}

/** The same without the shortcut (exported for tests, which compare the two). */
export function normalizeDecimalByPattern(s: string): Decimal | undefined {
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

/** value = coef / 10^scale. */
function toScaled(d: Decimal): { coef: bigint; scale: number } {
  const { neg, int, frac } = parts(d);
  const coef = BigInt(int + frac);
  return { coef: neg ? -coef : coef, scale: frac.length };
}

function fromScaled(coef: bigint, scale: number): Decimal {
  const neg = coef < 0n;
  const digits = (neg ? -coef : coef).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = frac === "" ? int : `${int}.${frac}`;
  return (body === "0" ? "0" : `${neg ? "-" : ""}${body}`) as Decimal;
}

function align(a: Decimal, b: Decimal): { x: bigint; y: bigint; scale: number } {
  const p = toScaled(a);
  const q = toScaled(b);
  const scale = Math.max(p.scale, q.scale);
  return { x: p.coef * 10n ** BigInt(scale - p.scale), y: q.coef * 10n ** BigInt(scale - q.scale), scale };
}

/** How a result is rounded to its digits: the names and meanings of Intl.NumberFormat's `roundingMode`. */
export type Rounding = "ceil" | "floor" | "expand" | "trunc" | "halfCeil" | "halfFloor" | "halfExpand" | "halfTrunc" | "halfEven";
const ROUNDINGS: readonly Rounding[] = ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"];

function checkDigits(what: string, digits: number): void {
  if (!Number.isInteger(digits) || digits < 0 || digits > 100) throw new RangeError(`${what} digits must be an integer from 0 to 100, got ${digits}`);
}

function checkRounding(what: string, rounding: Rounding): void {
  if (!ROUNDINGS.includes(rounding)) throw new RangeError(`${what} rounding must be one of ${ROUNDINGS.join(", ")}, got ${String(rounding)}`);
}

/** n / d rounded to an integer by `mode` (d ≠ 0). */
function roundQuotient(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const m = neg ? -n : n;
  let q = m / d;
  const r = m % d;
  if (r !== 0n) {
    // Where the remainder lies against half the divisor: below, at or above.
    const half = 2n * r === d ? 0 : 2n * r > d ? 1 : -1;
    const up =
      mode === "trunc" ? false
      : mode === "expand" ? true
      : mode === "ceil" ? !neg
      : mode === "floor" ? neg
      : half !== 0 ? half > 0
      : mode === "halfExpand" ? true
      : mode === "halfTrunc" ? false
      : mode === "halfCeil" ? !neg
      : mode === "halfFloor" ? neg
      : q % 2n === 1n; // halfEven
    if (up) q += 1n;
  }
  return neg ? -q : q;
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

  // Sums, differences and products of decimals are exact decimals, so these never
  // round. A quotient usually is not: div takes the digits to keep and how to round.

  add(a: Decimal, b: Decimal): Decimal {
    const { x, y, scale } = align(a, b);
    return fromScaled(x + y, scale);
  },

  sub(a: Decimal, b: Decimal): Decimal {
    const { x, y, scale } = align(a, b);
    return fromScaled(x - y, scale);
  },

  mul(a: Decimal, b: Decimal): Decimal {
    const p = toScaled(a);
    const q = toScaled(b);
    return fromScaled(p.coef * q.coef, p.scale + q.scale);
  },

  /**
   * `a / b` with `digits` fraction digits, rounded by `rounding` (default
   * `"halfExpand"`, half away from zero). Exact: the quotient is rounded once, from
   * its true value. Throws RangeError when `b` is zero.
   */
  div(a: Decimal, b: Decimal, digits: number, rounding: Rounding = "halfExpand"): Decimal {
    checkDigits("div()", digits);
    checkRounding("div()", rounding);
    const p = toScaled(a);
    const q = toScaled(b);
    if (q.coef === 0n) throw new RangeError("Decimal division by zero");
    // a / b × 10^digits = p.coef × 10^(q.scale + digits) / (q.coef × 10^p.scale)
    const n = p.coef * 10n ** BigInt(q.scale + digits);
    const d = q.coef * 10n ** BigInt(p.scale);
    return fromScaled(roundQuotient(n, d, rounding), digits);
  },

  /** `d` with at most `digits` fraction digits, rounded by `rounding` (default `"halfExpand"`). */
  round(d: Decimal, digits: number, rounding: Rounding = "halfExpand"): Decimal {
    checkDigits("round()", digits);
    checkRounding("round()", rounding);
    const p = toScaled(d);
    if (p.scale <= digits) return d;
    return fromScaled(roundQuotient(p.coef, 10n ** BigInt(p.scale - digits), rounding), digits);
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
   * Fixed-point display string with exactly `digits` fraction digits, rounded by
   * `rounding` (default `"halfExpand"`, half away from zero, the Intl.NumberFormat
   * default). Never prints a negative zero.
   */
  toFixed(d: Decimal, digits: number, rounding: Rounding = "halfExpand"): string {
    checkDigits("toFixed()", digits);
    checkRounding("toFixed()", rounding);
    const { neg, int, frac } = parts(Decimal.round(d, digits, rounding));
    return `${neg ? "-" : ""}${int}${digits === 0 ? "" : `.${frac.padEnd(digits, "0")}`}`;
  },
} as const;
