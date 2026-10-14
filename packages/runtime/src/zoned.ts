import type { Brand } from "./brand.js";

/**
 * An instant together with the UTC offset it was written in, kept as a canonical
 * ISO 8601 string: `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`. Seconds are always
 * present, fraction trailing zeros are dropped and a zero offset is written `Z`,
 * so `===` means "same instant written in the same offset".
 */
export type Zoned = string & Brand<"Zoned">;

type Fields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fraction digits without trailing zeros, at most 9 (nanoseconds). */
  fraction: string;
  offsetMinutes: number;
};

const SYNTAX =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

const MAX_OFFSET = 23 * 60 + 59;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return m === 2 ? (isLeapYear(y) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

function parse(s: string): (Fields & { canonical: boolean }) | undefined {
  const m = SYNTAX.exec(s);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  // No "24:00" and no leap second: neither has a single unambiguous instant.
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  let offsetMinutes = 0;
  if (m[8] === undefined) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return undefined;
    // RFC 3339: "-00:00" means the offset is unknown, which is what Zoned exists to rule out.
    if (m[9] === "-" && oh === 0 && om === 0) return undefined;
    offsetMinutes = (m[9] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const fraction = (m[7] ?? "").replace(/0+$/, "");
  // Whether `s` is already what format() would write, so it can be returned as is:
  // an upper-case T, seconds present, a "." fraction without trailing zeros, and
  // a zero offset written "Z" (not "z" or "+00:00").
  const canonical =
    s.charCodeAt(10) === 0x54 &&
    m[6] !== undefined &&
    (m[7] === undefined || (s.charCodeAt(19) === 0x2e && fraction === m[7])) &&
    (m[8] === undefined ? offsetMinutes !== 0 : m[8] === "Z");
  return { year, month, day, hour, minute, second, fraction, offsetMinutes, canonical };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function format(f: Fields): Zoned {
  const date = `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}`;
  const time = `${pad(f.hour, 2)}:${pad(f.minute, 2)}:${pad(f.second, 2)}`;
  const frac = f.fraction === "" ? "" : `.${f.fraction}`;
  let offset = "Z";
  if (f.offsetMinutes !== 0) {
    const abs = Math.abs(f.offsetMinutes);
    offset = `${f.offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
  }
  return `${date}T${time}${frac}${offset}` as Zoned;
}

function digit(s: string, i: number): number {
  const d = s.charCodeAt(i) - 0x30;
  return d >= 0 && d <= 9 ? d : NaN;
}

function two(s: string, i: number): number {
  return digit(s, i) * 10 + digit(s, i + 1);
}

/**
 * Whether `s` is a valid Zoned already in canonical form, checked without the
 * regular expression: what servers send, and what decode sees most. NaN from a
 * non-digit fails every range check below.
 */
function isCanonical(s: string): boolean {
  const n = s.length;
  if (n < 20 || s.charCodeAt(4) !== 0x2d || s.charCodeAt(7) !== 0x2d || s.charCodeAt(10) !== 0x54) return false;
  if (s.charCodeAt(13) !== 0x3a || s.charCodeAt(16) !== 0x3a) return false;
  const year = two(s, 0) * 100 + two(s, 2);
  const month = two(s, 5);
  const day = two(s, 8);
  if (!(year >= 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month))) return false;
  if (!(two(s, 11) <= 23 && two(s, 14) <= 59 && two(s, 17) <= 59)) return false;
  let i = 19;
  if (s.charCodeAt(i) === 0x2e) {
    const start = ++i;
    while (i < n && i - start < 9 && digit(s, i) >= 0) i++;
    // 1 to 9 digits, the last not a zero.
    if (i === start || s.charCodeAt(i - 1) === 0x30) return false;
  }
  if (s.charCodeAt(i) === 0x5a) return i + 1 === n;
  const sign = s.charCodeAt(i);
  if ((sign !== 0x2b && sign !== 0x2d) || i + 6 !== n || s.charCodeAt(i + 3) !== 0x3a) return false;
  const oh = two(s, i + 1);
  const om = two(s, i + 4);
  // A zero offset is written "Z".
  return oh <= 23 && om <= 59 && oh + om > 0;
}

export function normalizeZoned(s: string): Zoned | undefined {
  return isCanonical(s) ? (s as Zoned) : normalizeZonedByPattern(s);
}

/** The same without the shortcut (exported for tests, which compare the two). */
export function normalizeZonedByPattern(s: string): Zoned | undefined {
  const f = parse(s);
  if (f === undefined) return undefined;
  return f.canonical ? (s as Zoned) : format(f);
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (H. Hinnant, "chrono-Compatible Low-Level Date Algorithms").
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fieldsOf(z: Zoned): Fields {
  const f = parse(z);
  if (f === undefined) throw new TypeError("Not a Zoned value");
  return f;
}

function epochNanoseconds(z: Zoned): bigint {
  const f = fieldsOf(z);
  const days = BigInt(daysFromCivil(f.year, f.month, f.day));
  const seconds = BigInt(f.hour * 3600 + f.minute * 60 + f.second - f.offsetMinutes * 60);
  const nanos = BigInt(f.fraction.padEnd(9, "0"));
  return (days * 86_400n + seconds) * 1_000_000_000n + nanos;
}

function preview(s: string): string {
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
}

export const Zoned = {
  /** For values written in the program; untrusted strings go through `decode`. */
  from(value: string): Zoned {
    const z = normalizeZoned(value);
    if (z === undefined) throw new SyntaxError(`Invalid Zoned: ${preview(value)}`);
    return z;
  },

  /**
   * The instant `date` denotes, written in `offsetMinutes` (default: the
   * environment's local offset at that instant).
   */
  fromDate(date: Date, offsetMinutes: number = -date.getTimezoneOffset()): Zoned {
    const t = date.getTime();
    if (Number.isNaN(t)) throw new RangeError("Invalid Date");
    if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET) {
      throw new RangeError(`Offset must be an integer number of minutes within ±${MAX_OFFSET}`);
    }
    const local = new Date(t + offsetMinutes * 60_000);
    const year = local.getUTCFullYear();
    // Written as a positive range check so the NaN of an out-of-range Date also fails it.
    if (!(year >= 0 && year <= 9999)) throw new RangeError("Zoned supports years 0000 to 9999");
    return format({
      year,
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      second: local.getUTCSeconds(),
      fraction: pad(local.getUTCMilliseconds(), 3).replace(/0+$/, ""),
      offsetMinutes,
    });
  },

  /** Truncates to milliseconds (toward the past), since that is all `Date` holds. */
  toDate(z: Zoned): Date {
    const ns = epochNanoseconds(z);
    const ms = ns >= 0n ? ns / 1_000_000n : -((-ns + 999_999n) / 1_000_000n);
    return new Date(Number(ms));
  },

  epochNanoseconds,

  offsetMinutes(z: Zoned): number {
    return fieldsOf(z).offsetMinutes;
  },

  sameInstant(a: Zoned, b: Zoned): boolean {
    return a === b || epochNanoseconds(a) === epochNanoseconds(b);
  },

  /** Orders by instant only: values that differ only in offset compare as 0. */
  compare(a: Zoned, b: Zoned): -1 | 0 | 1 {
    if (a === b) return 0;
    const x = epochNanoseconds(a);
    const y = epochNanoseconds(b);
    return x === y ? 0 : x < y ? -1 : 1;
  },
} as const;
