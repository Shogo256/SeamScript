import type { Brand } from "./brand.js";
import { type Decimal, normalizeDecimal } from "./decimal.js";
import { Int64, parseInt64 } from "./int64.js";
import { type DecodeError, type Result, err, ok } from "./result.js";
import { type Text, type TextForm, decodeText } from "./text.js";
import { type Zoned, normalizeZoned } from "./zoned.js";

/**
 * Nesting deeper than this is reported as a decode failure instead of risking a
 * stack overflow. It also stops cyclic `postMessage` payloads, which JSON cannot carry.
 */
export const MAX_DEPTH = 512;

// Internal entry points, keyed by symbols so they stay out of autocomplete.
export const RUN = Symbol("seamscript.run");
export const WRITE = Symbol("seamscript.write");

class Failure {
  /** Innermost segment first; reversed once when the error is reported. */
  readonly reversedPath: string[] = [];
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {}
}

type Step<T> = T | Failure;

/** What `encode` produces: a value `JSON.stringify` accepts and round-trips through `decode`. */
export type Encoded<T> = T extends bigint
  ? string
  : T extends Brand<string>
    ? string
    : T extends string | number | boolean | null | undefined
      ? T
      : T extends readonly (infer U)[]
        ? Encoded<U>[]
        : T extends object
          ? { [K in keyof T]: Encoded<T[K]> }
          : T;

export interface Decoder<T> {
  /** What this decoder accepts, as reported in `DecodeError.expected`. */
  readonly expected: string;
  /** Never throws for bad data: failures come back as `{ ok: false }`. */
  decode(input: unknown): Result<T, DecodeError>;
  /** Throws `EncodeRangeError` if an Int64 is outside the 64-bit range. */
  encode(value: T): Encoded<T>;
  readonly [RUN]: (input: unknown, depth: number) => Step<T>;
  // Method syntax keeps Decoder covariant in practice, so a Decoder<Order> can be
  // stored where a Decoder<unknown> is expected (lists of decoders, union members).
  [WRITE](value: T): unknown;
}

export interface OptionalDecoder<T> extends Decoder<T | undefined> {
  readonly optional: true;
  readonly inner: Decoder<T>;
}

export interface LiteralDecoder<L extends string | number> extends Decoder<L> {
  readonly values: readonly L[];
}

/** Optional keys of `T` take `__b.optional(...)`; every other key takes a plain decoder. */
export type ObjectShape<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? OptionalDecoder<Exclude<T[K], undefined>> : Decoder<T[K]>;
};

export interface ObjectDecoder<T> extends Decoder<T> {
  readonly shape: ObjectShape<T>;
}


/** Thrown by `encode` when a value cannot cross the boundary (an Int64 out of range). */
export class EncodeRangeError extends RangeError {
  override readonly name = "EncodeRangeError";
  readonly path: string[] = [];
  constructor(private readonly detail: string) {
    super(detail);
  }
  /** @internal Prepends a path segment while the error unwinds. */
  at(segment: string): this {
    this.path.unshift(segment);
    this.message = `${this.detail} at ${JSON.stringify(this.path)}`;
    return this;
  }
}

function finish<T>(step: Step<T>): Result<T, DecodeError> {
  if (!(step instanceof Failure)) return ok(step);
  return err({
    kind: "decode",
    path: step.reversedPath.slice().reverse(),
    expected: step.expected,
    actual: step.actual,
  });
}

function make<T, X extends object = {}>(
  expected: () => string,
  run: (input: unknown, depth: number) => Step<T>,
  write: (value: T) => unknown,
  extra?: X,
): Decoder<T> & X {
  const d: Decoder<T> = {
    get expected() {
      return expected();
    },
    decode: (input) => finish(run(input, 0)),
    encode: (value) => write(value) as Encoded<T>,
    [RUN]: run,
    [WRITE]: write,
  };
  // Descriptors rather than Object.assign, so getters in `extra` stay lazy.
  if (extra !== undefined) Object.defineProperties(d, Object.getOwnPropertyDescriptors(extra));
  return d as Decoder<T> & X;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// For literal mismatches the received value is the useful part ("pending" vs "paid" | "open").
// Only short strings and numbers are shown; anything else is reported by type.
function describeLiteral(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length <= 40) return JSON.stringify(v);
  return describe(v);
}

const ABSENT = Symbol("absent");
const UNREADABLE = Symbol("unreadable");

// Own properties only: a missing "constructor" field must not read Object.prototype.constructor.
// Exotic inputs (proxies, throwing getters) fail to decode instead of throwing.
function readOwn(obj: object, key: string): unknown {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : ABSENT;
  } catch {
    return UNREADABLE;
  }
}

function readIndex(arr: readonly unknown[], i: number): unknown {
  try {
    return arr[i];
  } catch {
    return UNREADABLE;
  }
}

function set(out: Record<string, unknown>, key: string, value: unknown): void {
  // Plain assignment to "__proto__" would replace the prototype instead of adding a field.
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = value;
  }
}

function fail(expected: string, actual: string, segment: string): Failure {
  const f = new Failure(expected, actual);
  f.reversedPath.push(segment);
  return f;
}

function tooDeep(): Failure {
  return new Failure(`nesting depth <= ${MAX_DEPTH}`, "deeper nesting");
}

function writeAt<T>(d: Decoder<T>, value: T, segment: string): unknown {
  try {
    return d[WRITE](value);
  } catch (e) {
    if (e instanceof EncodeRangeError) e.at(segment);
    throw e;
  }
}

const identity = <T>(v: T): unknown => v;

function primitive<T>(name: string, test: (v: unknown) => v is T): Decoder<T> {
  return make<T>(
    () => name,
    (v) => (test(v) ? v : new Failure(name, describe(v))),
    identity,
  );
}

const string = primitive("string", (v): v is string => typeof v === "string");
const boolean = primitive("boolean", (v): v is boolean => typeof v === "boolean");
const null_ = primitive("null", (v): v is null => v === null);

// JSON cannot produce NaN or Infinity; a postMessage payload can, and neither survives encode.
const number = make<number>(
  () => "number",
  (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : new Failure("number", typeof v === "number" ? "number (non-finite)" : describe(v)),
  identity,
);

const int64 = make<Int64>(
  () => "int64",
  (v) => {
    if (typeof v === "number") {
      if (Number.isSafeInteger(v)) return BigInt(v);
      return new Failure("int64", Number.isInteger(v) ? "number (unsafe integer)" : "number (not an integer)");
    }
    if (typeof v === "string") return parseInt64(v) ?? new Failure("int64", "string (not a canonical int64)");
    if (typeof v === "bigint") return Int64.inRange(v) ? v : new Failure("int64", "bigint (out of range)");
    return new Failure("int64", describe(v));
  },
  (v) => {
    if (!Int64.inRange(v)) throw new EncodeRangeError("Int64 out of range");
    return v.toString();
  },
);

const decimal = make<Decimal>(
  () => "decimal",
  (v) =>
    typeof v === "string" ? (normalizeDecimal(v) ?? new Failure("decimal", "string (not a decimal)")) : new Failure("decimal", describe(v)),
  identity,
);

const zoned = make<Zoned>(
  () => "zoned",
  (v) =>
    typeof v === "string"
      ? (normalizeZoned(v) ?? new Failure("zoned", "string (not ISO 8601 with an offset)"))
      : new Failure("zoned", describe(v)),
  identity,
);

function text<F extends TextForm>(f: F): Decoder<Text<F>> {
  return make<Text<F>>(
    () => "text",
    (v) => (typeof v === "string" ? (decodeText(v, f) ?? new Failure("text", "string (lone surrogate)")) : new Failure("text", describe(v))),
    identity,
  );
}

function literal<const L extends readonly (string | number)[]>(...values: L): LiteralDecoder<L[number]> {
  const expected = values.map((v) => JSON.stringify(v)).join(" | ");
  return make<L[number], { values: L }>(
    () => expected,
    (v) => (values.includes(v as L[number]) ? (v as L[number]) : new Failure(expected, describeLiteral(v))),
    identity,
    { values },
  );
}

function array<T>(item: Decoder<T>): Decoder<T[]> {
  return make<T[]>(
    () => `${item.expected}[]`,
    (v, depth) => {
      if (!Array.isArray(v)) return new Failure(`${item.expected}[]`, describe(v));
      if (depth >= MAX_DEPTH) return tooDeep();
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        const raw = readIndex(v, i);
        if (raw === UNREADABLE) return fail(item.expected, "unreadable", String(i));
        const r = item[RUN](raw, depth + 1);
        if (r instanceof Failure) {
          r.reversedPath.push(String(i));
          return r;
        }
        out.push(r);
      }
      return out;
    },
    (value) => value.map((x, i) => writeAt(item, x, String(i))),
  );
}

function optional<T>(inner: Decoder<T>): OptionalDecoder<T> {
  return make<T | undefined, { optional: true; inner: Decoder<T> }>(
    () => `${inner.expected} | undefined`,
    (v, depth) => (v === undefined ? undefined : inner[RUN](v, depth)),
    (value) => (value === undefined ? undefined : inner[WRITE](value)),
    { optional: true, inner },
  );
}

function isOptional(d: Decoder<unknown>): d is OptionalDecoder<unknown> {
  return (d as Partial<OptionalDecoder<unknown>>).optional === true;
}

function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return make<T | null>(
    () => `${inner.expected} | null`,
    (v, depth) => {
      if (v === null) return null;
      const r = inner[RUN](v, depth);
      // A type mismatch at this level should say that null was also acceptable.
      // Other failures here (the depth limit) keep their own message.
      if (r instanceof Failure && r.reversedPath.length === 0 && r.expected === inner.expected) {
        return new Failure(`${inner.expected} | null`, r.actual);
      }
      return r;
    },
    (value) => (value === null ? null : inner[WRITE](value)),
  );
}

/** For recursive boundaries: the decoder is looked up on first use, after the module has initialized. */
function lazy<T>(get: () => Decoder<T>): Decoder<T> {
  let cached: Decoder<T> | undefined;
  const resolve = () => (cached ??= get());
  return make<T>(
    () => resolve().expected,
    (v, depth) => resolve()[RUN](v, depth),
    (value) => resolve()[WRITE](value),
  );
}

function object<T extends object>(shape: ObjectShape<T>): ObjectDecoder<T> {
  const entries = Object.keys(shape).map((k) => [k, (shape as Record<string, Decoder<unknown>>)[k]!] as const);
  return make<T, { shape: ObjectShape<T> }>(
    () => "object",
    (v, depth) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return new Failure("object", describe(v));
      if (depth >= MAX_DEPTH) return tooDeep();
      const out: Record<string, unknown> = {};
      for (const [key, d] of entries) {
        const raw = readOwn(v, key);
        if (raw === UNREADABLE) return fail(d.expected, "unreadable", key);
        let r: Step<unknown>;
        if (isOptional(d)) {
          // `name?:` allows the key to be absent, not null. An own `undefined`
          // (possible through postMessage, not JSON) counts as absent.
          if (raw === ABSENT || raw === undefined) continue;
          r = d.inner[RUN](raw, depth + 1);
        } else {
          if (raw === ABSENT) return fail(d.expected, "missing", key);
          r = d[RUN](raw, depth + 1);
        }
        if (r instanceof Failure) {
          r.reversedPath.push(key);
          return r;
        }
        set(out, key, r);
      }
      // Keys not in the shape are dropped, so a backend adding fields breaks nothing.
      return out as T;
    },
    (value) => {
      const out: Record<string, unknown> = {};
      for (const [key, d] of entries) {
        const x = (value as Record<string, unknown>)[key];
        if (x === undefined && isOptional(d)) continue;
        set(out, key, writeAt(d, x, key));
      }
      return out;
    },
    { shape },
  );
}

/**
 * A discriminated union of boundaries. Each member must have a literal field
 * `key` whose values no other member uses. Members are passed as a thunk so a
 * union can be declared before the boundaries it names.
 */
function union<T extends object>(key: string, members: () => readonly ObjectDecoder<object>[]): Decoder<T> {
  let table: Map<string | number, ObjectDecoder<object>> | undefined;
  let expectedTag = "";
  const build = (): Map<string | number, ObjectDecoder<object>> => {
    if (table !== undefined) return table;
    const t = new Map<string | number, ObjectDecoder<object>>();
    for (const m of members()) {
      const tag = (m.shape as Record<string, Decoder<unknown>>)[key] as Partial<LiteralDecoder<string | number>> | undefined;
      if (tag?.values === undefined) throw new TypeError(`Union member has no literal field "${key}"`);
      for (const lit of tag.values) {
        if (t.has(lit)) throw new TypeError(`Union members overlap on ${key} = ${JSON.stringify(lit)}`);
        t.set(lit, m);
      }
    }
    expectedTag = [...t.keys()].map((x) => JSON.stringify(x)).join(" | ");
    return (table = t);
  };
  return make<T>(
    () => "object",
    (v, depth) => {
      const t = build();
      if (typeof v !== "object" || v === null || Array.isArray(v)) return new Failure("object", describe(v));
      const raw = readOwn(v, key);
      if (raw === UNREADABLE) return fail(expectedTag, "unreadable", key);
      if (raw === ABSENT) return fail(expectedTag, "missing", key);
      const member = typeof raw === "string" || typeof raw === "number" ? t.get(raw) : undefined;
      if (member === undefined) return fail(expectedTag, describeLiteral(raw), key);
      return member[RUN](v, depth) as Step<T>;
    },
    (value) => {
      const tag = (value as Record<string, unknown>)[key];
      const member = typeof tag === "string" || typeof tag === "number" ? build().get(tag) : undefined;
      if (member === undefined) throw new TypeError(`No union member for ${key} = ${String(tag)}`);
      return member[WRITE](value);
    },
  );
}

/** Decoder constructors used by compiled `boundary` declarations. */
export const __b = {
  string,
  number,
  boolean,
  null: null_,
  int64,
  decimal,
  zoned,
  text,
  literal,
  array,
  optional,
  nullable,
  lazy,
  object,
  union,
} as const;

/** Compiled form of `decode X from v`. */
export function __decode<T>(decoder: Decoder<T>, input: unknown): Result<T, DecodeError> {
  return decoder.decode(input);
}
