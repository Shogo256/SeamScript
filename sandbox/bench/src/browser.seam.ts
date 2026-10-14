// The suite in a browser page; the result lands on window.__bench.
import { runSuite, type SuiteResult } from "./suite.seam";

declare global {
  interface Window {
    __bench?: (SuiteResult & { env: string; isolated: boolean }) | { error: string };
    __benchProgress?: string;
  }
}

// URLSearchParams.get is outside data like any other: ?only= is decoded, not compared.
const only = decode "decode" | "text" | null from new URLSearchParams(location.search).get("only");
runSuite({
  only: only.ok && only.value !== null ? only.value : undefined,
  // Yield between cases so the page stays alive for the test runner.
  pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
  progress: (label) => {
    window.__benchProgress = label;
  },
})
  .then((r) => {
    window.__bench = { env: navigator.userAgent, isolated: crossOriginIsolated, ...r };
    document.body.textContent = "done";
  })
  .catch((e: unknown) => {
    window.__bench = { error: String(e) };
  });
