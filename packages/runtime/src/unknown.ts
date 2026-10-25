import type { Brand } from "./brand.js";

/**
 * Data from outside the program. TypeScript already rejects property access and
 * `as` to unrelated types; the compiler's checker pass rejects every other way out
 * except `decode`.
 */
export type Unknown = Brand<"Unknown">;

export const Unknown = {
  /** Debug-only exit: prints the value and returns nothing. */
  log<T>(value: T): void {
    console.log(value);
  },
} as const;

/** Emitted by the compiler around source expressions (`JSON.parse(...)`, `Storage.getItem(...)`, ...). */
export function __unknown(value: unknown): Unknown {
  return value as Unknown;
}

/**
 * The same for a source that is an array of outside data, element by element: an
 * AudioWorklet's `inputs`, where `inputs[0]` (one input's channels) is decoded.
 */
export function __unknownEach(value: unknown): readonly Unknown[] {
  return value as readonly Unknown[];
}

/** The same for sources that return a promise (`Response.json()`). The promise itself is passed through. */
export function __unknownAsync(value: PromiseLike<unknown>): Promise<Unknown> {
  return value as Promise<Unknown>;
}
