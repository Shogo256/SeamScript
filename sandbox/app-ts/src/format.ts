// Display formatting the usual way: decimal strings through Number, graphemes
// through the browser's Intl.Segmenter.

export function fractionDigits(tick: string): number {
  const dot = tick.indexOf(".");
  return dot < 0 ? 0 : tick.length - dot - 1;
}

export function price(d: string, tick: string): string {
  return Number(d).toFixed(fractionDigits(tick));
}

export function change(last: string, prevClose: string, digits: number): { diff: string; percent: string; sign: -1 | 0 | 1 } {
  const diff = Number(last) - Number(prevClose);
  const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
  const percent = ((diff / Number(prevClose)) * 100).toFixed(2);
  const text = diff.toFixed(digits);
  return { diff: sign > 0 ? `+${text}` : text, percent: sign > 0 ? `+${percent}` : percent, sign };
}

export function notional(p: string, quantity: number, digits: number): string {
  return (Number(p) * quantity).toFixed(digits);
}

const JST_MS = 9 * 60 * 60_000;

export function clock(iso: string): string {
  return new Date(Date.parse(iso) + JST_MS).toISOString().slice(11, 23);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

export function preview(s: string, max: number): string {
  const parts = [...segmenter.segment(s)];
  return parts.length > max ? `${parts.slice(0, max).map((p) => p.segment).join("")}…` : s;
}

const STATUS: Record<string, string> = { open: "open", partially_filled: "partially filled", filled: "filled", cancelled: "cancelled" };

export function statusLabel(status: string): string {
  return STATUS[status] ?? status;
}

const groups = new Intl.NumberFormat("en-US");

export function int(n: number | string): string {
  return groups.format(typeof n === "string" ? BigInt(n) : n);
}
