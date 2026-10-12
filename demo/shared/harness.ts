// Shared by both sides' tests, so the two run the same checks the same way.
import { spawnSync } from "node:child_process";
import { vi } from "vitest";

/**
 * Replaces fetch with one whose responses are held until `release(url)`, so the
 * order in which answers arrive is fixed by the test instead of left to chance.
 */
export function heldFetch(body: (url: string) => unknown) {
  const pending = new Map<string, () => void>();
  vi.stubGlobal("fetch", (url: string) =>
    new Promise<Response>((resolve) => {
      pending.set(url, () => resolve(new Response(JSON.stringify(body(url)))));
    }),
  );
  return {
    release(url: string) {
      const go = pending.get(url);
      if (go === undefined) throw new Error(`no request to ${url}`);
      go();
    },
  };
}

/** Lets pending promise chains and response bodies finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Whether `preview` (minus a trailing "…") is `original` cut between two whole characters. */
export function cutsCleanly(original: string, preview: string): boolean {
  const cut = preview.endsWith("…") ? preview.slice(0, -1) : preview;
  if (!cut.isWellFormed()) return false;
  let prefix = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(original)) {
    if (prefix === cut) return true;
    prefix += segment;
  }
  return prefix === cut;
}

/** Runs a Node script and returns its exit status and combined output. */
export function runNode(script: string, args: string[], cwd: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** 9 characters, then 🎂 (two UTF-16 code units) at code units 9–10. */
export const BIRTHDAY_MEMO = "お誕生日おめでとう🎂ケーキ";

export const SEARCH_URL = (q: string) => `/api/search?q=${encodeURIComponent(q)}`;
