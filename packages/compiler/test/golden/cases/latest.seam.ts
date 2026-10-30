// latest functions: plain, with an AbortSignal, generic, and a fork.
import { Order } from "./shapes.seam";
import { ok } from "@seamscript/runtime";

export latest async function search(q: Text<NFC>, signal: AbortSignal) {
  const res = await fetch(`/search?q=${encodeURIComponent(q)}`, { signal });
  return decode Order[] from await res.json();
}

export latest async function count(n: number) {
  return ok(n + 1);
}

export latest async function get<T extends object>(key: string, signal: AbortSignal): Promise<Result<T | null, DecodeError>> {
  void key;
  void signal;
  return ok(null);
}

export async function useSearch(q: Text<NFC>) {
  const mine = search.fork();
  const r = await mine(q);
  if (!r.ok && r.error.kind === "stale") return [];
  mine.cancel();
  return r.ok ? r.value : [];
}
