// Each test asks whether one bug is stopped before it reaches a user.
import { Text } from "@seamscript/runtime";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { BIRTHDAY_MEMO, cutsCleanly, heldFetch, runNode, SEARCH_URL, settle } from "../../shared/harness.js";
import { memoPreview } from "../src/memo-preview.seam";
import { createScreen } from "../src/screen.js";
import { onSearchInput } from "../src/search.seam";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

afterEach(() => vi.unstubAllGlobals());

it("1. an unchecked cast of API data is stopped before it runs", () => {
  const seamc = join(dirname(require.resolve("@seamscript/compiler")), "..", "bin", "seamc.js");
  const r = runNode(seamc, ["check", "src/load-order.seam.ts"], root);
  expect(r.status, r.output).toBe(1);
  // `const u: unknown = v;` — the line that widens the response before the cast.
  expect(r.output).toMatch(/load-order\.seam\.ts\(9,\d+\): error SEAM2001/);
});

it("2. the memo preview never splits a character", () => {
  const preview = memoPreview(Text.nfc(BIRTHDAY_MEMO));
  expect(cutsCleanly(BIRTHDAY_MEMO, preview), `preview was ${JSON.stringify(preview)}`).toBe(true);
});

it("3. the newest search stays on screen", async () => {
  const server = heldFetch((url) => {
    const q = new URL(url, "http://demo").searchParams.get("q")!;
    return { query: q, hits: q.length };
  });
  const screen = createScreen();
  // Typing "ab" then "abc"; the answer for "ab" arrives last.
  const typing = [onSearchInput(screen, "ab"), onSearchInput(screen, "abc")];
  await settle();
  server.release(SEARCH_URL("abc"));
  await settle();
  server.release(SEARCH_URL("ab"));
  await Promise.all(typing);
  expect(screen.resultsFor, "results on screen are for").toBe("abc");
});
