import { ApiError, type NewOrder, type Order, OrderAccepted, OrderDetail, SearchResult } from "./api";
import { describeProblem, err, getJson, type HttpProblem, ok, parse, requestJson, type Result } from "./http";
import { latestLine } from "./latest";

export const searchInstruments = () =>
  latestLine((signal: AbortSignal, query: string) => getJson(`/api/instruments?q=${encodeURIComponent(query)}`, SearchResult, signal));

export const loadOrderDetail = () => latestLine((signal: AbortSignal, id: string) => getJson(`/api/orders/${id}`, OrderDetail, signal));

export type CommandProblem = { kind: "rejected"; status: number; message: string; field?: string } | { kind: "failed"; message: string };

const RETRIES = 3;

export async function placeOrder(order: NewOrder): Promise<Result<Order, CommandProblem>> {
  return command("/api/orders", JSON.stringify({ ...order, quantity: String(order.quantity) }));
}

export async function cancelOrder(id: string): Promise<Result<Order, CommandProblem>> {
  return command(`/api/orders/${id}/cancel`, "{}");
}

async function command(url: string, body: string): Promise<Result<Order, CommandProblem>> {
  let last = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(150 * 2 ** (attempt - 1));
    const r = await requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!r.ok) {
      last = describeHttp(r.error);
      continue;
    }
    const { status } = r.value;
    if (status === 200 || status === 201) {
      const a = parse(OrderAccepted, r.value.body);
      return a.ok ? ok(a.value.order) : err({ kind: "failed", message: describeProblem(a.error) });
    }
    if (status >= 500) {
      last = `HTTP ${status}`;
      continue;
    }
    const e = parse(ApiError, r.value.body);
    return err(e.ok ? { kind: "rejected", status, message: e.value.error, field: e.value.field } : { kind: "rejected", status, message: `HTTP ${status}` });
  }
  return err({ kind: "failed", message: `failed after ${RETRIES + 1} attempts: ${last}` });
}

function describeHttp(p: HttpProblem): string {
  return p.kind === "network" ? `network error (${p.message})` : `response is not valid JSON (HTTP ${p.status})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
