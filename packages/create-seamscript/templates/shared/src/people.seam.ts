import { err } from "@seamscript/runtime";

// What the server sends, checked field by field when it arrives. `Text` counts
// characters as people see them; Int64, Decimal and Zoned keep ids, money and
// times exact.
export boundary Person {
  id: Int64,
  name: Text<NFC> minLength 1 maxLength 80,
  email: string matches /^[^@\s]+@[^@\s]+$/,
  joined: Zoned,
  balance: Decimal,
}

// A newer call makes the previous one's result Stale and aborts its request, so
// a slow answer never overwrites a newer one.
export latest async function loadPerson(id: number, signal: AbortSignal) {
  const res = await fetch(`/people/${id}.json`, { signal });
  if (!res.ok) return err({ kind: "http" as const, status: res.status });
  return decode Person from await res.json();
}

export type Problem = { kind: "http"; status: number } | DecodeError;

export function describeProblem(p: Problem): string {
  return p.kind === "http" ? `The server answered ${p.status}.` : `Unexpected data at ${p.path.join(".") || "the top level"}: expected ${p.expected}, got ${p.actual}.`;
}
