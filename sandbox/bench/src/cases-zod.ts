// The TypeScript side of the decode benchmarks. A plain .ts file: in a .seam.ts
// file JSON.parse returns Unknown, which SeamScript does not let reach Zod.
import * as Idiomatic from "../../app-ts/src/api";
import fixtures from "../fixtures/messages.json";
import type { Case } from "./harness";
import * as Equivalent from "./zod-equivalent";

export function zodCases(): Case[] {
  const tick: unknown = JSON.parse(fixtures.tick);
  const order: unknown = JSON.parse(fixtures.order);
  const snapshot: unknown = JSON.parse(fixtures.snapshot);
  return [
    { group: "decode: tick", name: "Zod (the TS app's schemas)", fn: () => Idiomatic.ServerMessage.safeParse(tick) },
    { group: "decode: tick", name: "Zod (same checks as SeamScript)", fn: () => Equivalent.ServerMessage.safeParse(tick) },
    { group: "decode: order event", name: "Zod (the TS app's schemas)", fn: () => Idiomatic.ServerMessage.safeParse(order) },
    { group: "decode: order event", name: "Zod (same checks as SeamScript)", fn: () => Equivalent.ServerMessage.safeParse(order) },
    { group: "decode: snapshot (40 + 1000 orders)", name: "Zod (the TS app's schemas)", fn: () => Idiomatic.Snapshot.safeParse(snapshot) },
    { group: "decode: snapshot (40 + 1000 orders)", name: "Zod (same checks as SeamScript)", fn: () => Equivalent.Snapshot.safeParse(snapshot) },
    { group: "parse + decode: tick", name: "JSON.parse only", fn: () => JSON.parse(fixtures.tick) },
    { group: "parse + decode: tick", name: "Zod (the TS app's schemas)", fn: () => Idiomatic.ServerMessage.safeParse(JSON.parse(fixtures.tick)) },
  ];
}

/** Checks that each case does what it says before timing it. */
export function verifyZod(): void {
  for (const c of zodCases()) {
    const r = c.fn() as { success?: boolean };
    if (r.success === false) throw new Error(`${c.group} / ${c.name} failed to parse its fixture`);
  }
}
