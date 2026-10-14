// decode and Text micro-benchmarks: in Node (with the WASM core and on Node's
// ICU), then in each browser (with the WASM core), one environment at a time.
import { type BrowserName, log, run, startBackend, withBrowser } from "./lib.ts";

export interface MicroRun {
  env: string;
  text: { deterministic: boolean; unicode: string | null };
  isolated?: boolean;
  results: { group: string; name: string; p50: number; p95: number; p99: number; mean: number; samples: number; batch: number }[];
}

export async function micro(options: {
  browsers: BrowserName[];
  /** Per browser. On timeout the browser is closed and the run goes on without it. */
  timeoutMs: number;
  /** Called after each environment, with what has been measured so far. */
  save: (partial: Record<string, MicroRun>) => void;
}): Promise<Record<string, MicroRun>> {
  const out: Record<string, MicroRun> = {};
  log("micro: Node, WASM core");
  out["node (core)"] = JSON.parse(run(process.execPath, ["bench/dist/node-core/node.seam.js"]));
  options.save(out);
  log("micro: Node, host ICU (Text only)");
  out["node (host ICU)"] = JSON.parse(run(process.execPath, ["bench/dist/node-host/node.seam.js", "text"]));
  options.save(out);
  const server = await startBackend(["--static", "/bench/=bench/dist/browser"]);
  try {
    for (const name of options.browsers) {
      log(`micro: ${name}`);
      try {
        out[name] = await withBrowser(name, async (b) => {
          const page = await b.newPage();
          await page.goto(`${server.url}/bench/bench.html`);
          // Polled from here, not with waitForFunction: a page busy in a long
          // synchronous loop cannot run an in-page poll, so its timeout never fires.
          const deadline = Date.now() + options.timeoutMs;
          for (;;) {
            const r = await Promise.race([
              page.evaluate(() => (window as unknown as { __bench?: MicroRun | { error: string } }).__bench ?? null),
              new Promise<"busy">((resolve) => setTimeout(() => resolve("busy"), 5000)),
            ]);
            if (r !== null && r !== "busy") {
              if ("error" in r) throw new Error(r.error);
              return { ...r, env: `${name} ${b.version()}` };
            }
            if (Date.now() > deadline) {
              const at = await Promise.race([page.evaluate(() => (window as { __benchProgress?: string }).__benchProgress ?? ""), new Promise<string>((resolve) => setTimeout(() => resolve("(page busy)"), 2000))]);
              throw new Error(`timed out after ${options.timeoutMs / 60_000} min at: ${at}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        });
      } catch (e) {
        log(`micro: ${name} failed: ${String(e)}`);
      }
      options.save(out);
    }
  } finally {
    await server.stop();
  }
  return out;
}
