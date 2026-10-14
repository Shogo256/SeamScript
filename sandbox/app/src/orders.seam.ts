// Requests other than the feed: search, order detail, placing and cancelling.
import { err, ok } from "@seamscript/runtime";
import { ApiError, NewOrder, type Order, OrderAccepted, OrderDetail, SearchResult } from "./api.seam";
import { describeProblem, getJson, type HttpProblem, requestJson } from "./http.seam";

// Typing fast sends a request per keystroke; only the answer to the newest one is shown.
export latest async function searchInstruments(query: Text<NFC>, signal: AbortSignal) {
  const r = await getJson(`/api/instruments?q=${encodeURIComponent(query)}`, signal);
  if (!r.ok) return r;
  return decode SearchResult from r.value;
}

// Clicking through orders: a slow answer for the previous order never replaces the current one.
export latest async function loadOrderDetail(id: Int64, signal: AbortSignal) {
  const r = await getJson(`/api/orders/${id}`, signal);
  if (!r.ok) return r;
  return decode OrderDetail from r.value;
}

export type CommandProblem =
  | { readonly kind: "rejected"; readonly status: number; readonly message: string; readonly field?: string }
  | { readonly kind: "failed"; readonly message: string };

const RETRIES = 3;

/**
 * POST /api/orders. A network error or a 5xx leaves it unknown whether the order
 * was created, so the same body (same clientOrderId) is sent again: the server
 * answers a repeat with the order it already made, never a second one.
 */
export async function placeOrder(order: NewOrder): Promise<Result<Order, CommandProblem>> {
  // encode turns Int64 into strings, so the body survives JSON.stringify exactly.
  const body = JSON.stringify(NewOrder.encode(order));
  return command("/api/orders", body);
}

export async function cancelOrder(id: Int64): Promise<Result<Order, CommandProblem>> {
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
      const a = decode OrderAccepted from r.value.body;
      return a.ok ? ok(a.value.order) : err({ kind: "failed", message: describeProblem(a.error) });
    }
    if (status >= 500) {
      last = `HTTP ${status}`;
      continue;
    }
    const e = decode ApiError from r.value.body;
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
