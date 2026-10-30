import {
  type Bytes,
  type Pcm,
  type Planar,
  type SampleFormat,
  bytesOf,
  firstNonFinite,
  isWav,
  readWav,
  sampleBytes,
  samplesOf,
} from "./audio.js";
import type { Brand } from "./brand.js";
import { type Decimal, normalizeDecimal } from "./decimal.js";
import { Int64, parseInt64 } from "./int64.js";
import { type DecodeError, type DecodeRule, type Result, err, ok } from "./result.js";
import { Text, type TextForm, decodeText } from "./text.js";
import { __unbox } from "./unknown.js";
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
    readonly rule: DecodeRule = "type",
  ) {}
}

type Step<T> = T | Failure;

/**
 * What `encode` produces: a value `JSON.stringify` accepts and that round-trips
 * through `decode`. Binary types encode to what `WebSocket.send` and
 * `postMessage` take: `Pcm` to its little-endian sample bytes, `Bytes` to itself,
 * `Planar` to its channel arrays.
 */
export type Encoded<T> = T extends bigint
  ? string
  : T extends Pcm<SampleFormat, number, number>
    ? ArrayBuffer
    : T extends Planar<"float32", number>
      ? Float32Array[]
      : T extends Bytes
        ? Uint8Array<ArrayBuffer>
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
  /**
   * `decode T from json text`: parses `text` as JSON, then decodes it. Input that
   * is not a string, or not JSON, is a DecodeError too, never an exception.
   */
  decodeJson(text: unknown): Result<T, DecodeError>;
  /**
   * Throws `EncodeRangeError` if an Int64 is outside the 64-bit range. NoInfer:
   * inferring T backwards from `Encoded<T>` would find the unbranded shape (all
   * strings) and drop the brands of what `__decode(decoder, v)` returns.
   */
  encode(value: T): Encoded<NoInfer<T>>;
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
    rule: step.rule,
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
    decode: (input) => finish(run(__unbox(input), 0)),
    decodeJson: (text) => {
      const parsed = parseJson(__unbox(text));
      return finish(parsed instanceof Failure ? parsed : run(parsed.value, 0));
    },
    encode: (value) => write(value) as Encoded<T>,
    [RUN]: run,
    [WRITE]: write,
  };
  // Descriptors rather than Object.assign, so getters in `extra` stay lazy.
  if (extra !== undefined) Object.defineProperties(d, Object.getOwnPropertyDescriptors(extra));
  return d as Decoder<T> & X;
}

// The parser's message is not passed on: it quotes the input, which may be personal data.
function parseJson(text: unknown): Failure | { value: unknown } {
  if (typeof text !== "string") return new Failure("JSON text", describe(text));
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return new Failure("JSON", "malformed JSON", "json");
  }
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

function fail(expected: string, actual: string, segment: string, rule: DecodeRule): Failure {
  const f = new Failure(expected, actual, rule);
  f.reversedPath.push(segment);
  return f;
}

function tooDeep(): Failure {
  return new Failure(`nesting depth <= ${MAX_DEPTH}`, "deeper nesting", "depth");
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
    typeof v === "number" ? (Number.isFinite(v) ? v : new Failure("number", "number (non-finite)", "nonFinite")) : new Failure("number", describe(v)),
  identity,
);

const int64 = make<Int64>(
  () => "int64",
  (v) => {
    if (typeof v === "number") {
      if (Number.isSafeInteger(v)) return BigInt(v);
      return new Failure("int64", Number.isInteger(v) ? "number (unsafe integer)" : "number (not an integer)", Number.isInteger(v) ? "range" : "value");
    }
    if (typeof v === "string") return parseInt64(v) ?? new Failure("int64", "string (not a canonical int64)", "value");
    if (typeof v === "bigint") return Int64.inRange(v) ? v : new Failure("int64", "bigint (out of range)", "range");
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
    typeof v === "string" ? (normalizeDecimal(v) ?? new Failure("decimal", "string (not a decimal)", "value")) : new Failure("decimal", describe(v)),
  identity,
);

const zoned = make<Zoned>(
  () => "zoned",
  (v) =>
    typeof v === "string"
      ? (normalizeZoned(v) ?? new Failure("zoned", "string (not ISO 8601 with an offset)", "value"))
      : new Failure("zoned", describe(v)),
  identity,
);

function text<F extends TextForm>(f: F): Decoder<Text<F>> {
  return make<Text<F>>(
    () => "text",
    (v) => (typeof v === "string" ? (decodeText(v, f) ?? new Failure("text", "string (lone surrogate)", "value")) : new Failure("text", describe(v))),
    identity,
  );
}

function literal<const L extends readonly (string | number)[]>(...values: L): LiteralDecoder<L[number]> {
  const expected = values.map((v) => JSON.stringify(v)).join(" | ");
  return make<L[number], { values: L }>(
    () => expected,
    (v) => (values.includes(v as L[number]) ? (v as L[number]) : new Failure(expected, describeLiteral(v), values.some((x) => typeof x === typeof v) ? "value" : "type")),
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
      const run = item[RUN];
      for (let i = 0; i < v.length; i++) {
        const raw = readIndex(v, i);
        if (raw === UNREADABLE) return fail(item.expected, "unreadable", String(i), "unreadable");
        const r = run(raw, depth + 1);
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
        return new Failure(`${inner.expected} | null`, r.actual, r.rule);
      }
      return r;
    },
    (value) => (value === null ? null : inner[WRITE](value)),
  );
}

/**
 * A boundary field's constraint (`matches /re/`, `minLength 1`, `in 1..65535`):
 * `inner`, narrowed by `test`. A value that fails it is a decode failure; one
 * given to `encode` throws EncodeRangeError, since it would not decode again.
 * A mismatch of `inner` itself reports this decoder's expectation.
 */
function constrained<T>(inner: Decoder<T>, rule: string, kind: DecodeRule, test: (value: T) => string | undefined): Decoder<T> {
  const expected = `${inner.expected} ${rule}`;
  return make<T>(
    () => expected,
    (v, depth) => {
      const r = inner[RUN](v, depth);
      if (r instanceof Failure) {
        return r.reversedPath.length === 0 && r.expected === inner.expected ? new Failure(expected, r.actual, r.rule) : r;
      }
      const problem = test(r);
      return problem === undefined ? r : new Failure(expected, problem, kind);
    },
    (value) => {
      const problem = test(value);
      if (problem !== undefined) throw new EncodeRangeError(`Expected ${expected}, got ${problem}`);
      return inner[WRITE](value);
    },
  );
}

/** `matches /re/` on a string or Text field. The pattern is used without its global or sticky flags. */
function matches<T extends string>(inner: Decoder<T>, pattern: RegExp): Decoder<T> {
  // `test` with the g or y flag advances lastIndex, so one value's result would depend on the previous one.
  const re = pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
  // The value itself is not reported: it may be personal data.
  return constrained(inner, `matching ${pattern}`, "pattern", (v) => (re.test(v) ? undefined : `${inner.expected} (no match)`));
}

/**
 * `minLength` / `maxLength`: grapheme clusters of a Text, elements of an array,
 * bytes of `Bytes`, frames (samples per channel) of `Pcm` and `Planar`.
 */
function length<T extends string | { readonly length: number } | { readonly frames: number }>(inner: Decoder<T>, min: number, max: number = Infinity): Decoder<T> {
  const rule = max === Infinity ? `of length ${min} or more` : min === 0 ? `of length ${max} or less` : `of length ${min}..${max}`;
  return constrained(inner, rule, "length", (v) => {
    const x: string | { readonly length: number } | { readonly frames: number } = v;
    const n = typeof x === "string" ? Text.length(x as Text<TextForm>) : "frames" in x ? x.frames : x.length;
    return n >= min && n <= max ? undefined : `length ${n}`;
  });
}

/** `in A..B` on a number or Int64 field: both ends included. */
function range<T extends number | bigint>(inner: Decoder<T>, min: T, max: T): Decoder<T> {
  return constrained(inner, `in ${min}..${max}`, "range", (v) => (v >= min && v <= max ? undefined : `${inner.expected} (out of range)`));
}

// Binary inputs are named by their class, never by their contents.
function describeBinary(v: unknown): string {
  if (v instanceof ArrayBuffer) return "ArrayBuffer";
  if (ArrayBuffer.isView(v)) return v.buffer instanceof ArrayBuffer ? v.constructor.name : `${v.constructor.name} over a SharedArrayBuffer`;
  if (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer) return "SharedArrayBuffer";
  return describe(v);
}

/**
 * The bytes of an ArrayBuffer or of a view (TypedArray, DataView) on one, without
 * copying. Shared memory is refused: another thread could change it after the check.
 */
function bytesIn(v: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) {
    return v instanceof Uint8Array ? (v as Uint8Array<ArrayBuffer>) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return undefined;
}

const bytes = make<Bytes>(
  () => "bytes",
  (v) => (bytesIn(v) as Bytes | undefined) ?? new Failure("bytes", describeBinary(v)),
  (value) => value,
);

const WAV_FORMATS: Record<SampleFormat, { code: number; bits: number; name: string }> = {
  int16: { code: 1, bits: 16, name: "16-bit integer PCM" },
  float32: { code: 3, bits: 32, name: "32-bit float PCM" },
};

/**
 * `Pcm<Int16 | Float32, Rate, Channels>`: interleaved little-endian samples, as
 * bytes (ArrayBuffer, any view) or as the typed array of the format, or a WAV
 * file whose header must match the declaration. Plain bytes carry no sample rate
 * or channel count, so for them only the frame alignment can be checked.
 */
function pcm<F extends SampleFormat, R extends number, C extends number>(format: F, sampleRate: R, channels: C): Decoder<Pcm<F, R, C>> {
  const size = sampleBytes(format);
  const frame = size * channels;
  const expected = `pcm ${format} ${sampleRate} Hz ${channels}ch`;
  const wav = WAV_FORMATS[format];
  const SampleArray = format === "int16" ? Int16Array : Float32Array;
  return make<Pcm<F, R, C>>(
    () => expected,
    (v) => {
      let samples: Int16Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
      if (v instanceof SampleArray && v.buffer instanceof ArrayBuffer) {
        // Samples already in the declared format, as posted from an AudioWorklet.
        if (v.length % channels !== 0) return new Failure(expected, `${v.length} samples, not a whole number of ${channels}-channel frames`, "frameAlignment");
        samples = v as Int16Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
      } else {
        let data = bytesIn(v);
        if (data === undefined) return new Failure(expected, describeBinary(v));
        if (isWav(data)) {
          const info = readWav(data);
          if (typeof info === "string") return new Failure(expected, info, "format");
          if (info.formatCode !== wav.code || info.bitsPerSample !== wav.bits) {
            return new Failure(expected, `wav of format ${info.formatCode}, ${info.bitsPerSample}-bit (expected ${wav.name})`, "format");
          }
          if (info.sampleRate !== sampleRate) return new Failure(expected, `wav at ${info.sampleRate} Hz`, "sampleRate");
          if (info.channels !== channels) return new Failure(expected, `wav with ${info.channels} channels`, "channels");
          data = info.data;
        }
        if (data.byteLength % frame !== 0) return new Failure(expected, `${data.byteLength} bytes, not a whole number of ${frame}-byte frames`, "frameAlignment");
        samples = samplesOf(format, data);
      }
      if (format === "float32") {
        const at = firstNonFinite(samples as Float32Array);
        if (at !== -1) return new Failure(expected, `a non-finite sample at frame ${Math.floor(at / channels)}`, "nonFinite");
      }
      return { format, sampleRate, channels, frames: samples.length / channels, samples } as unknown as Pcm<F, R, C>;
    },
    (value) => {
      if (value.samples.length % channels !== 0) throw new EncodeRangeError(`Expected ${expected}, got ${value.samples.length} samples`);
      return bytesOf(value.samples);
    },
  );
}

/**
 * `Planar<Float32, Channels>`: an array of one Float32Array per channel, all the
 * same length, such as `inputs[0]` in an AudioWorklet's `process`. The arrays
 * are wrapped, not copied. An input that is not connected has no channels, and
 * fails with rule "channels".
 */
function planar<F extends "float32", C extends number>(format: F, channels: C): Decoder<Planar<F, C>> {
  const expected = `planar ${format} ${channels}ch`;
  return make<Planar<F, C>>(
    () => expected,
    (v) => {
      if (!Array.isArray(v)) return new Failure(expected, describe(v));
      if (v.length !== channels) return new Failure(expected, `${v.length} channel${v.length === 1 ? "" : "s"}`, "channels");
      let frames = -1;
      for (let i = 0; i < channels; i++) {
        const ch = readIndex(v, i);
        if (ch === UNREADABLE) return fail("float32 samples", "unreadable", String(i), "unreadable");
        if (!(ch instanceof Float32Array) || !(ch.buffer instanceof ArrayBuffer)) return fail("float32 samples", describeBinary(ch), String(i), "type");
        if (frames === -1) frames = ch.length;
        else if (ch.length !== frames) return fail(`${frames} samples`, `${ch.length} samples`, String(i), "frameAlignment");
        if (firstNonFinite(ch) !== -1) return fail("finite float32 samples", "a non-finite sample", String(i), "nonFinite");
      }
      return { format, channels: v, frames: Math.max(frames, 0) } as unknown as Planar<F, C>;
    },
    (value) => [...value.channels],
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
  // Resolved once, so the loop below reads plain arrays instead of decoder objects
  // of many different shapes (whose property loads the engine cannot cache).
  const keys = entries.map(([k]) => k);
  const decoders = entries.map(([, d]) => d);
  const optional = decoders.map(isOptional);
  const runs = decoders.map((d) => (isOptional(d) ? d.inner[RUN] : d[RUN]));
  const n = keys.length;
  return make<T, { shape: ObjectShape<T> }>(
    () => "object",
    (v, depth) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return new Failure("object", describe(v));
      if (depth >= MAX_DEPTH) return tooDeep();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = keys[i]!;
        const raw = readOwn(v, key);
        if (raw === UNREADABLE) return fail(decoders[i]!.expected, "unreadable", key, "unreadable");
        if (optional[i]) {
          // `name?:` allows the key to be absent, not null. An own `undefined`
          // (possible through postMessage, not JSON) counts as absent.
          if (raw === ABSENT || raw === undefined) continue;
        } else if (raw === ABSENT) {
          return fail(decoders[i]!.expected, "missing", key, "missing");
        }
        const r = runs[i]!(raw, depth + 1);
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

type Members = () => readonly ObjectDecoder<object>[];

function literalValues(m: ObjectDecoder<object>, key: string): readonly (string | number)[] | undefined {
  const d = (m.shape as Record<string, Decoder<unknown>>)[key] as Partial<LiteralDecoder<string | number>> | undefined;
  return d?.values;
}

/** The first field of the first member that is a literal in every member, with no value shared between members. */
function findDiscriminant(members: readonly ObjectDecoder<object>[]): string | undefined {
  const [first] = members;
  if (first === undefined) return undefined;
  candidates: for (const key of Object.keys(first.shape)) {
    const seen = new Set<string | number>();
    for (const m of members) {
      const values = literalValues(m, key);
      if (values === undefined) continue candidates;
      for (const v of values) {
        if (seen.has(v)) continue candidates;
        seen.add(v);
      }
    }
    return key;
  }
  return undefined;
}

/**
 * A discriminated union of boundaries. Each member must have a literal field
 * whose values no other member uses; without an explicit `key`, the first such
 * field is used. Members are passed as a thunk so a union can be declared before
 * the boundaries it names.
 */
function union<T extends object>(members: Members): Decoder<T>;
function union<T extends object>(key: string, members: Members): Decoder<T>;
function union<T extends object>(keyOrMembers: string | Members, maybeMembers?: Members): Decoder<T> {
  const members = typeof keyOrMembers === "string" ? maybeMembers! : keyOrMembers;
  let key = typeof keyOrMembers === "string" ? keyOrMembers : "";
  let table: Map<string | number, ObjectDecoder<object>> | undefined;
  let expectedTag = "";
  const build = (): Map<string | number, ObjectDecoder<object>> => {
    if (table !== undefined) return table;
    const all = members();
    if (typeof keyOrMembers !== "string") {
      const found = findDiscriminant(all);
      if (found === undefined) throw new TypeError("Union members have no literal field with distinct values");
      key = found;
    }
    const t = new Map<string | number, ObjectDecoder<object>>();
    for (const m of all) {
      const values = literalValues(m, key);
      if (values === undefined) throw new TypeError(`Union member has no literal field "${key}"`);
      for (const lit of values) {
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
      if (raw === UNREADABLE) return fail(expectedTag, "unreadable", key, "unreadable");
      if (raw === ABSENT) return fail(expectedTag, "missing", key, "missing");
      const member = typeof raw === "string" || typeof raw === "number" ? t.get(raw) : undefined;
      if (member === undefined) return fail(expectedTag, describeLiteral(raw), key, typeof raw === "string" || typeof raw === "number" ? "value" : "type");
      return member[RUN](v, depth) as Step<T>;
    },
    (value) => {
      const t = build(); // sets `key` when it is detected
      const tag = (value as Record<string, unknown>)[key];
      const member = typeof tag === "string" || typeof tag === "number" ? t.get(tag) : undefined;
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
  matches,
  length,
  range,
  bytes,
  pcm,
  planar,
} as const;

/** Compiled form of `decode X from v`. */
export function __decode<T>(decoder: Decoder<T>, input: unknown): Result<T, DecodeError> {
  return decoder.decode(input);
}

/** Compiled form of `decode X from json text`. */
export function __decodeJson<T>(decoder: Decoder<T>, text: unknown): Result<T, DecodeError> {
  return decoder.decodeJson(text);
}
