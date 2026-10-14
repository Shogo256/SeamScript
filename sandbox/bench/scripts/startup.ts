// What loading the WASM core adds to start-up.
//
// Browser: the same app built with and without the core, loaded alternately in
// fresh contexts. Measured: when the app's main module starts (performance mark
// "seam:main", which with the core waits for its top-level await), and the
// time spent inside WebAssembly.instantiate (wrapped by an init script).
// Node: a fresh process importing @seamscript/core, against one importing only
// @seamscript/runtime.
import { type BrowserName, log, run, sandbox, shuffled, type Summary, startBackend, summary, withBrowser } from "./lib.ts";

const WRAP_INSTANTIATE = `(() => {
  const original = WebAssembly.instantiate;
  window.__wasm = [];
  WebAssembly.instantiate = function (...args) {
    const t0 = performance.now();
    const p = original.apply(this, args);
    p.then(() => window.__wasm.push(performance.now() - t0), () => {});
    return p;
  };
})();`;

export interface StartupResult {
  browsers: Record<string, { core: Summary; noCore: Summary; instantiate: Summary }>;
  node: { core: Summary; runtimeOnly: Summary };
}

export async function startup(options: { browsers: BrowserName[]; loads: number; nodeRuns: number }): Promise<StartupResult> {
  const out: StartupResult = { browsers: {}, node: { core: summary([]), runtimeOnly: summary([]) } };
  const server = await startBackend();
  try {
    for (const name of options.browsers) {
      const main: Record<string, number[]> = { "/": [], "/no-core/": [] };
      const instantiate: number[] = [];
      await withBrowser(name, async (b) => {
        for (let i = 0; i < options.loads; i++) {
          for (const path of shuffled(["/", "/no-core/"])) {
            const ctx = await b.newContext();
            const page = await ctx.newPage();
            await page.addInitScript(WRAP_INSTANTIATE);
            await page.goto(server.url + path);
            await page.waitForFunction(() => performance.getEntriesByName("seam:main").length > 0);
            const r = await page.evaluate(() => ({
              main: performance.getEntriesByName("seam:main")[0]!.startTime,
              wasm: (window as unknown as { __wasm: number[] }).__wasm,
            }));
            main[path]!.push(r.main);
            if (path === "/") instantiate.push(...r.wasm);
            await ctx.close();
          }
        }
        out.browsers[`${name} ${b.version()}`] = { core: summary(main["/"]!), noCore: summary(main["/no-core/"]!), instantiate: summary(instantiate) };
      });
      log(`startup: ${name} done`);
    }
  } finally {
    await server.stop();
  }
  const time = (module: string) =>
    Number(run(process.execPath, ["--input-type=module", "-e", `const t0 = performance.now(); await import("${module}"); console.log(performance.now() - t0);`], `${sandbox}app`).trim());
  const core: number[] = [];
  const runtimeOnly: number[] = [];
  for (let i = 0; i < options.nodeRuns; i++) {
    for (const m of shuffled(["@seamscript/core", "@seamscript/runtime"])) (m === "@seamscript/core" ? core : runtimeOnly).push(time(m));
  }
  out.node = { core: summary(core), runtimeOnly: summary(runtimeOnly) };
  return out;
}
