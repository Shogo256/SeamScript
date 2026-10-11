export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export type DecodeError = {
  kind: "decode";
  path: string[];
  expected: string;
  actual: string;
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
