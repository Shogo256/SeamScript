import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, cleanup } from "./helpers.js";

afterAll(cleanup);

const ORDER = `// The spec's examples, in one module.
export boundary Order {
  id: Int64,
  memo: Text<NFC>,
  total: Decimal,
  placedAt: Zoned,
  tags?: string[],
  parent: Order | null,
}

boundary Paid { kind: "paid", amount: Decimal }
boundary Refunded { kind: "refunded", reason: Text<NFC> | null }
export boundary PaymentEvent = Paid | Refunded

export async function load(id: Int64) {
  const res = await fetch(\`/api/order/\${id}\`);
  const r = decode Order from await res.json();
  if (r.ok) {
    const total: Decimal = r.value.total;
    const memoLength: number = Text.length(r.value.memo);
    return { total, memoLength, body: JSON.stringify(Order.encode(r.value)) };
  }
  return r.error.path;
}

// Results from any call older than the newest one are discarded.
export latest async function search(q: Text<NFC>, signal: AbortSignal) {
  const res = await fetch(\`/api/search?q=\${q}\`, { signal });
  return decode Order[] from await res.json();
}

export async function onInput(value: string) {
  const r = await search(Text.nfc(value));
  if (r.ok) return r.value.length;
  if (r.error.kind === "stale") return undefined;
  return r.error.expected;
}

export const line = search.fork();

export function restore() {
  return decode Text<NFC> | null from localStorage.getItem("q");
}
`;

describe("type checking .seam.ts", () => {
  it("accepts the spec's examples under --strict", () => {
    const { diagnostics } = check({ "order.seam.ts": ORDER });
    expect(diagnostics).toEqual([]);
  });

  it("lets plain .ts files import boundaries from .seam.ts", () => {
    const { diagnostics } = check({
      "order.seam.ts": ORDER,
      "main.ts": 'import { Order, search } from "./order.seam";\nexport const f = (o: Order) => Order.encode(o).id.length;\nvoid search;\n',
    });
    expect(diagnostics).toEqual([]);
  });

  it("reports type errors at their original position", () => {
    const { paths, diagnostics } = check({
      "a.seam.ts": "boundary P { n: number }\n\nexport function f(v: unknown) {\n  const r = decode P from v;\n  if (r.ok) {\n    const s: string = r.value.n;\n  }\n}\n",
    });
    expect(diagnostics).toMatchObject([{ file: paths[0], line: 6, column: 11, code: "TS2322" }]);
  });

  it("reports SeamScript errors next to TypeScript's", () => {
    const { diagnostics } = check({ "a.seam.ts": "export boundary P { n: any }\nexport const x: number = 'no';\n" });
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["SEAM1101", 1],
      ["TS2322", 2],
    ]);
  });

  it("reports a latest function that does not return a Result on its declaration", () => {
    const { diagnostics } = check({ "a.seam.ts": "\nexport latest async function f() {\n  return 1;\n}\n" });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.line === 2)).toBe(true);
  });

  it("does not pile type errors on a file that failed to parse", () => {
    const { diagnostics } = check({ "a.seam.ts": "boundary X {\n" });
    expect(diagnostics.map((d) => d.code)).toEqual(["SEAM1000"]);
  });
});

// Milestone: the compiler turns a .seam.ts file into plain TypeScript that passes
// `tsc --strict`, checked with the real tsc binary on the emitted file.
it("emits plain TypeScript that passes tsc --strict", () => {
  const { p, paths } = check({ "order.seam.ts": ORDER });
  const out = join(dirname(paths[0]!), "out", "order.seam.ts");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, p.outputs.get(paths[0]!)!.code);
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const args = ["--strict", "--noEmit", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2024,dom", out];
  expect(() => execFileSync(process.execPath, [tsc, ...args], { encoding: "utf8" })).not.toThrow();
});
