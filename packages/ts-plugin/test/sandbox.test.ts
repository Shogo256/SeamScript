// The sandbox's dashboard (React, about 1,500 lines of .seam.ts and .seam.tsx)
// in an editor: without the plugin tsserver reads SeamScript syntax as broken
// TypeScript; with it, the files check as cleanly as `seamc check` says they do.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { TsServer } from "./tsserver.js";

const repo = join(import.meta.dirname, "../../..");
const app = join(repo, "sandbox/app/src");
const files = readdirSync(app, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.seam\.tsx?$/.test(f))
  .map((f) => join(app, f));

const servers: TsServer[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function diagnostics(server: TsServer): Promise<Record<string, number>> {
  for (const file of files) await server.open(file);
  const out: Record<string, number> = {};
  for (const file of files) {
    const syntactic = await server.request<unknown[]>("syntacticDiagnosticsSync", { file });
    const semantic = await server.request<unknown[]>("semanticDiagnosticsSync", { file });
    if (syntactic.length + semantic.length > 0) out[file.slice(app.length + 1)] = syntactic.length + semantic.length;
  }
  return out;
}

it("has errors on SeamScript syntax without the plugin", async () => {
  const server = new TsServer();
  servers.push(server);
  expect(Object.keys(await diagnostics(server)).length).toBeGreaterThan(0);
});

it("has no errors with the plugin, as an editor extension loads it", async () => {
  const server = new TsServer({ plugins: ["@seamscript/ts-plugin"], probeLocation: repo });
  servers.push(server);
  expect(files.length).toBeGreaterThan(10);
  expect(await diagnostics(server)).toEqual({});
});
