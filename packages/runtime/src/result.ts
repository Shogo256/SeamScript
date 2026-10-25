export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Which check failed, for code that reacts to the kind of failure rather than
 * reading `expected` and `actual`:
 * - `type`: the value has the wrong type (a string where a number belongs)
 * - `value`: the right type with an unacceptable value (a literal not listed, a non-canonical Int64 string, a lone surrogate)
 * - `missing`: a required field is absent
 * - `unreadable`: reading the value threw (a getter, a Proxy)
 * - `depth`: nesting deeper than MAX_DEPTH
 * - `json`: the text is not JSON (`decode T from json text`)
 * - `pattern`, `length`, `range`: a field constraint (`matches`, `minLength` / `maxLength`, `in A..B`)
 * - `nonFinite`: NaN or an infinity (a number, Float32 samples)
 * - `format`, `sampleRate`, `channels`, `frameAlignment`: audio that doesn't match its `Pcm` / `Planar` declaration
 */
export type DecodeRule =
  | "type"
  | "value"
  | "missing"
  | "unreadable"
  | "depth"
  | "json"
  | "pattern"
  | "length"
  | "range"
  | "nonFinite"
  | "format"
  | "sampleRate"
  | "channels"
  | "frameAlignment";

export type DecodeError = {
  kind: "decode";
  path: string[];
  expected: string;
  actual: string;
  rule: DecodeRule;
};

export type Stale = Err<{ kind: "stale" }>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export const STALE: Stale = Object.freeze({
  ok: false,
  error: Object.freeze({ kind: "stale" }),
} as const);
