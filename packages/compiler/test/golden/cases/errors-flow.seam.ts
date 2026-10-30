// Each flow error once (the SEAM2xxx codes), and TypeScript's own on Unknown.
import { Order } from "./shapes.seam";

declare function launder<T>(x: T): any;

export async function flows(res: Response, e: MessageEvent, order: Order) {
  const v = await res.json();
  const asOrder = v as Order;
  const u: unknown = v;
  const text = `${v}`;
  const sum = v + 1;
  const has = "id" in v;
  const out = launder(v);
  const typed: Order = JSON.parse("{}");
  const parse = JSON.parse;
  const { data } = e;
  if (typeof v === "string") console.log(v.length);
  const memo = order.memo;
  const n = memo.length;
  const first = memo[0];
  const body = JSON.stringify(order);
  if (n > 1) throw v;
  return [asOrder, u, text, sum, has, out, typed, parse, data, first, body];
}
