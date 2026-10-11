import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import seamscript from "../src/vite.js";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

const quiet = () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return errors;
};

it("check: exit 0 when clean, 1 with diagnostics", () => {
  const errors = quiet();
  const [good, bad] = project({
    "good.seam.ts": "export boundary P { n: number }\n",
    "bad.seam.ts": "export const s = (v: Unknown) => v as string;\n",
  });
  expect(main(["check", good!])).toBe(0);
  expect(main(["check", bad!])).toBe(1);
  expect(errors.join("\n")).toMatch(/bad\.seam\.ts\(1,34\): error SEAM2001/);
  vi.restoreAllMocks();
});

it("build: writes plain TypeScript under the same file name", () => {
  quiet();
  const [file] = project({ "src/order.seam.ts": "export boundary Order { id: Int64 }\n" });
  const outDir = join(dirname(file!), "..", "out");
  expect(main(["build", "--outDir", outDir, file!])).toBe(0);
  expect(readFileSync(join(outDir, "order.seam.ts"), "utf8")).toContain("export const Order: __ObjectDecoder<Order>");
  vi.restoreAllMocks();
});

it("usage errors exit 2", () => {
  quiet();
  expect(main([])).toBe(2);
  expect(main(["build", "x.seam.ts"])).toBe(2);
  vi.restoreAllMocks();
});

it("vite plugin: compiles .seam.ts modules and leaves others", () => {
  const plugin = seamscript();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
  const ctx = { error: (msg: string) => { throw new Error(msg); } };
  expect(transform.call(ctx, "const r = decode P from v;", "/src/a.seam.ts?v=1")!.code).toContain("__decode(P, v)");
  expect(transform.call(ctx, "export {}", "/src/a.ts")).toBeNull();
  expect(() => transform.call(ctx, "boundary X { a: any }", "/src/b.seam.ts")).toThrow(/SEAM1101/);
});
