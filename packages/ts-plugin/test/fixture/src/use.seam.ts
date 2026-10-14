import { load, Order } from "./api.seam";

export async function show(id: string): Promise<number> {
  const r = await load(id);
  if (!r.ok) return -1;
  const raw = JSON.parse("{}");
  const leak = raw as { id: string };
  const bad: string = raw;
  console.log(leak, bad, Order.encode(r.value));
  return Text.length(r.value.memo);
}
