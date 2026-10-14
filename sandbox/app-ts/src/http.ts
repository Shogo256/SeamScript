import type { z } from "zod";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

export type HttpProblem = { kind: "network"; message: string } | { kind: "json"; status: number; message: string };
export type GetProblem = HttpProblem | { kind: "status"; status: number } | { kind: "decode"; message: string };

export async function requestJson(url: string, init?: RequestInit): Promise<Result<{ status: number; body: unknown }, HttpProblem>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return err({ kind: "network", message: describe(e) });
  }
  try {
    return ok({ status: res.status, body: (await res.json()) as unknown });
  } catch (e) {
    return err({ kind: "json", status: res.status, message: describe(e) });
  }
}

export async function getJson<T>(url: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<Result<T, GetProblem>> {
  const r = await requestJson(url, { signal });
  if (!r.ok) return r;
  if (r.value.status !== 200) return err({ kind: "status", status: r.value.status });
  return parse(schema, r.value.body);
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): Result<T, { kind: "decode"; message: string }> {
  const r = schema.safeParse(value);
  return r.success ? ok(r.data) : err({ kind: "decode", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
}

export function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export function describeProblem(p: GetProblem): string {
  switch (p.kind) {
    case "network":
      return `network error (${p.message})`;
    case "json":
      return `response is not valid JSON (HTTP ${p.status}: ${p.message})`;
    case "status":
      return `HTTP ${p.status}`;
    case "decode":
      return `wrong shape: ${p.message}`;
  }
}
