/**
 * A plain bigint. bigint is arbitrary precision, so arithmetic is not range checked;
 * the 64-bit range is enforced only when crossing a boundary (decode / encode).
 */
export type Int64 = bigint;

const MIN = -(1n << 63n);
const MAX = (1n << 63n) - 1n;

export const Int64 = {
  MIN,
  MAX,
  inRange(value: bigint): boolean {
    return value >= MIN && value <= MAX;
  },
} as const;

// Canonical decimal integers only: no sign on zero, no leading zeros, no "+".
// A zero-padded string ("007") is usually a code, not a number, so it is rejected.
const CANONICAL = /^(?:0|-?[1-9][0-9]{0,18})$/;

export function parseInt64(s: string): bigint | undefined {
  if (!CANONICAL.test(s)) return undefined;
  const value = BigInt(s);
  return Int64.inRange(value) ? value : undefined;
}
