import type { Order } from "./api.js";
import type { Screen } from "./screen.js";

// Bug 1. The Zod schema exists, but this path skips it: the response is widened
// to unknown and cast. tsc --strict and ESLint's recommended rules accept it.
export async function loadOrder(screen: Screen, id: number): Promise<void> {
  const res = await fetch(`/api/orders/${id}`);
  const v = await res.json();
  const u: unknown = v;
  screen.order = u as Order;
}
