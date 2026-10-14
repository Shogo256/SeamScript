// The packaged extension, loaded the way VS Code loads it: tsserver started with
// the plugin named in typescriptServerPlugins (--globalPlugins) and the
// extension's directory as the place to find it (--pluginProbeLocations).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { TsServer } from "../../ts-plugin/test/tsserver.js";

const root = join(import.meta.dirname, "..");
const stage = join(root, "dist/extension"); // what the .vsix holds (scripts/build.mjs)
const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
const app = join(root, "../../sandbox/app/src");

let server: TsServer | undefined;
afterAll(() => server?.close());

it("is packaged with its plugin", () => {
  expect(existsSync(join(root, "dist", `${manifest.name}-${manifest.version}.vsix`))).toBe(true);
  const [plugin] = manifest.contributes.typescriptServerPlugins;
  expect(existsSync(join(stage, "node_modules", plugin.name, "dist/index.cjs"))).toBe(true);
});

it("checks the sandbox's app cleanly with only what the extension ships", async () => {
  server = new TsServer({ plugins: manifest.contributes.typescriptServerPlugins.map((p: { name: string }) => p.name), probeLocation: stage });
  const files = readdirSync(app, { recursive: true, encoding: "utf8" }).filter((f) => /\.seam\.tsx?$/.test(f)).map((f) => join(app, f));
  for (const file of files) await server.open(file);
  const counts: Record<string, number> = {};
  for (const file of files) {
    const n = (await server.request<unknown[]>("syntacticDiagnosticsSync", { file })).length + (await server.request<unknown[]>("semanticDiagnosticsSync", { file })).length;
    if (n > 0) counts[file] = n;
  }
  expect(counts).toEqual({});
  // The plugin is really there: hover sees through decode.
  const feed = join(app, "feed.seam.ts");
  const text = readFileSync(feed, "utf8");
  const before = text.slice(0, text.indexOf("decode "));
  const info = await server.request<{ displayString: string }>("quickinfo", { file: feed, line: before.split("\n").length, offset: before.length - before.lastIndexOf("\n") + "decode ".length });
  expect(info.displayString).not.toBe("");
});
