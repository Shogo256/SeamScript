// Every kind of decode target, `from json`, and the results used after the check.
import { Order, PaymentEvent } from "./shapes.seam";

export async function load(id: string): Promise<string> {
  const res = await fetch(`/orders/${id}`);
  const r = decode Order from await res.json();
  if (!r.ok) return `${r.error.path.join(".")}: expected ${r.error.expected}, got ${r.error.actual} (${r.error.rule})`;
  return Decimal.toFixed(r.value.total, 2);
}

export function targets(v: Unknown) {
  const a = decode string from v;
  const b = decode number[] from v;
  const c = decode "buy" | "sell" from v;
  const d = decode (Order | null)[] from v;
  const e = decode Int64 from v;
  const f = decode Text<NFC> from v;
  const g = decode PaymentEvent from v;
  const h = decode Bytes from v;
  return [a, b, c, d, e, f, g, h];
}

export async function fromJson(res: Response, ws: WebSocket) {
  const order = decode Order from json await res.text();
  ws.onmessage = (e) => {
    const event = decode PaymentEvent from json e.data;
    if (event.ok && event.value.kind === "refunded") console.log(Text.length(event.value.reason));
  };
  const json = { body: "{}" };
  const plain = decode string from json.body;
  return [order, plain];
}
