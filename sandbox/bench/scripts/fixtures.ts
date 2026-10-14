// Writes the JSON payloads the decode benchmarks parse, made by the pseudo
// backend's own market and wire encoder: node scripts/fixtures.ts
import "@seamscript/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { Market, type MarketEvent } from "../../backend/src/market.ts";
import { eventJson, snapshotJson } from "../../backend/src/wire.ts";

const market = new Market({ seed: 42, instruments: 40, orders: 1000, now: () => Date.UTC(2026, 9, 12, 0, 0, 0, 123) });
let tick: MarketEvent | undefined;
let order: MarketEvent | undefined;
market.subscribe((e) => {
  if (e.kind === "tick") tick ??= e;
  // An order with a memo, so its Text field has something to normalize.
  else if (order === undefined && e.order.memo !== "") order = e;
});
while (tick === undefined || order === undefined) market.tick();

const fixtures = {
  tick: JSON.stringify(eventJson(tick)),
  order: JSON.stringify(eventJson(order)),
  snapshot: JSON.stringify(snapshotJson(market.snapshot())),
};
mkdirSync(new URL("../fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("../fixtures/messages.json", import.meta.url), JSON.stringify(fixtures));
console.log(Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, `${v.length} bytes`])));
