import { defineConfig, devices } from "@playwright/test";

// Run inside sandbox/e2e/shell.nix (browsers from nixpkgs). The apps must be built
// first: `yarn workspace @seamscript-sandbox/app build` (the `test` script does it).
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One worker per browser: each worker runs its own backend, and timing-sensitive
  // scenarios should not compete with more than two other browsers for the CPU.
  workers: 3,
  retries: 0,
  // On GitHub Actions, failures also become annotations, readable without the job log.
  reporter: [["list"], ...(process.env["GITHUB_ACTIONS"] ? [["github"] as const] : []), ["json", { outputFile: "results/report.json" }]],
  outputDir: "results/artifacts",
  use: { trace: "retain-on-failure" },
  projects: [
    // A fake microphone (a tone) with no permission prompt, for the voice sample.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
