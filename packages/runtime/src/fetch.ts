import type { Unknown } from "./unknown.js";

/** A `Response` whose body, once parsed as JSON, is `Unknown`. */
export type SeamResponse = Omit<Response, "json" | "clone"> & {
  json(): Promise<Unknown>;
  clone(): SeamResponse;
};

/**
 * The compiler imports this into every `.seam.ts` module, shadowing the global
 * `fetch` there. At runtime it is the global `fetch`, looked up per call so test
 * doubles installed later still apply; only the type of `json()` changes.
 */
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<SeamResponse> {
  return globalThis.fetch(input, init);
}
