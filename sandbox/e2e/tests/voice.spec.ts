// The voice sample (sandbox/voice): microphone audio goes to the server as Pcm
// chunks over a WebSocket, comes back through the same boundary, and is played.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

// Another echo server to run against, such as Throughline's (`ws://127.0.0.1:9000`);
// without it, the backend's own /voice/echo.
const echoUrl = process.env["VOICE_ECHO_URL"];

test.describe("Voice round trip", () => {
  // Chromium and Firefox get a fake microphone (playwright.config.ts); Playwright's
  // WebKit build has no capture device at all (enumerateDevices() is empty).
  test.skip(({ browserName }) => browserName === "webkit", "no capture device in Playwright's WebKit");

  type Stats = Record<"blocks" | "sent" | "received" | "rejected" | "matched" | "mismatched" | "unmatched" | "playingWindows" | "audibleWindows" | "maxOutputRms", number>;
  const stats = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __voice: { stats: Stats } }).__voice.stats }));
  /** A frame as the sample sends it: a 4-byte little-endian sequence number, then `payload`. */
  const sendRaw = (page: Page, what: { seq: number; payloadBytes: number } | { bytes: number } | "text") =>
    page.evaluate((w) => {
      const voice = (window as unknown as { __voice: { sendRaw(x: ArrayBufferView | string): void } }).__voice;
      if (w === "text") return voice.sendRaw("not audio");
      if ("bytes" in w) return voice.sendRaw(new Uint8Array(w.bytes));
      const frame = new Uint8Array(4 + w.payloadBytes);
      new DataView(frame.buffer).setUint32(0, w.seq, true);
      voice.sendRaw(frame);
    }, what);

  const startLive = async (page: Page) => {
    await page.goto(echoUrl === undefined ? "/voice/" : `/voice/?echo=${encodeURIComponent(echoUrl)}`);
    await page.getByTestId("start").click();
    await expect(page.getByTestId("status")).toHaveText("live");
  };

  test("Microphone audio comes back byte for byte under its sequence number, and is heard", async ({ page, backend, browserName }, testInfo) => {
    // Headless Firefox here never starts an AudioContext (it stays "suspended", even
    // after a click), so no microphone block ever reaches the page.
    test.skip(browserName === "firefox", "Web Audio does not run in headless Firefox here");
    void backend;
    await startLive(page);
    // The microphone's actual settings came through their boundary.
    await expect(page.getByTestId("mic")).toHaveText(/^(\d+|\?) Hz, (\d+|\?) ch \(resampled to 16000 Hz\)$/);
    // 20 ms chunks: 50 that came back identical is a second of audio.
    await expect.poll(async () => (await stats(page)).matched, { timeout: 20_000 }).toBeGreaterThanOrEqual(50);
    // Every chunk received has been compared: all of them matched what was sent under their number.
    await expect.poll(async () => {
      const s = await stats(page);
      return s.matched + s.mismatched + s.unmatched === s.received;
    }).toBe(true);
    const s = await stats(page);
    expect(s.blocks).toBeGreaterThan(0);
    expect(s.sent).toBeGreaterThanOrEqual(s.received);
    expect({ mismatched: s.mismatched, unmatched: s.unmatched, rejected: s.rejected }).toEqual({ mismatched: 0, unmatched: 0, rejected: 0 });
    // What was played was not silence: the output analyser saw sound while chunks were scheduled.
    await expect.poll(async () => (await stats(page)).audibleWindows, { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
    const level = await stats(page);
    expect(level.maxOutputRms).toBeGreaterThan(0.001);
    await expect(page.getByTestId("problem")).toBeEmpty();
    testInfo.annotations.push({ type: "round trip", description: JSON.stringify(level) });
  });

  test("A chunk changed on the way is caught by its hash", async ({ page, backend, browserName }) => {
    test.skip(browserName === "firefox", "Web Audio does not run in headless Firefox here");
    void backend;
    await startLive(page);
    await expect.poll(async () => (await stats(page)).matched, { timeout: 20_000 }).toBeGreaterThan(5);
    await page.evaluate(() => (window as unknown as { __voice: { corruptNext(): void } }).__voice.corruptNext());
    await expect.poll(async () => (await stats(page)).mismatched).toBe(1);
    await expect(page.getByTestId("problem")).toHaveText(/^Chunk \d+ came back different from what was sent$/);
    // Only that one: the chunks after it match again.
    const after = (await stats(page)).matched;
    await expect.poll(async () => (await stats(page)).matched).toBeGreaterThan(after + 5);
    expect((await stats(page)).mismatched).toBe(1);
  });

  test("Frames that are not numbered 16 kHz Int16 chunks are rejected with a typed error, and the stream goes on", async ({ page, backend }) => {
    void backend;
    await startLive(page);
    const frameAlignment =
      "Rejected a message: expected pcm int16 16000 Hz 1ch of length 1..1600, got 3 bytes, not a whole number of 2-byte frames (frameAlignment)";
    if (echoUrl === undefined) {
      // The backend's echo returns every message, so the page sees all three.
      await sendRaw(page, { bytes: 3 });
      await expect(page.getByTestId("problem")).toHaveText("Rejected a message: expected bytes of length 6..3204, got length 3 (length)");
      await sendRaw(page, { seq: 1_000_000, payloadBytes: 3 });
      await expect(page.getByTestId("problem")).toHaveText(frameAlignment);
      await sendRaw(page, "text");
      await expect(page.getByTestId("problem")).toHaveText("Rejected a message: expected bytes of length 6..3204, got string (type)");
    } else {
      // Throughline drops a binary message shorter than its 4-byte sequence number,
      // and any text message, so only the frame with 3 bytes of samples comes back.
      // Echoes keep their order: had the 3-byte frame come back, it would have been
      // rejected before it, and had the text come back, before the frame below.
      await sendRaw(page, { bytes: 3 });
      await sendRaw(page, { seq: 1_000_000, payloadBytes: 3 });
      await expect(page.getByTestId("problem")).toHaveText(frameAlignment);
      await sendRaw(page, "text");
    }
    const rejected = echoUrl === undefined ? 3 : 1;
    expect((await stats(page)).rejected).toBe(rejected);
    // A well-formed frame after them still comes back and is accepted; its number was never sent.
    const before = await stats(page);
    await sendRaw(page, { seq: 1_000_000, payloadBytes: 640 });
    await expect.poll(async () => (await stats(page)).unmatched).toBe(before.unmatched + 1);
    expect((await stats(page)).rejected).toBe(rejected);
  });

  test("Over a fixed 15-second window, chunks come back intact and are heard", async ({ page, backend, browserName }, testInfo) => {
    test.skip(browserName === "firefox", "Web Audio does not run in headless Firefox here");
    void backend;
    await startLive(page);
    // A fixed window rather than a threshold to wait for, so that the counts can be
    // compared between echo servers (they are recorded as an annotation).
    await page.waitForTimeout(15_000);
    const s = await stats(page);
    testInfo.annotations.push({ type: "15 s window", description: JSON.stringify({ echo: echoUrl ?? "backend", ...s }) });
    expect({ mismatched: s.mismatched, unmatched: s.unmatched, rejected: s.rejected }).toEqual({ mismatched: 0, unmatched: 0, rejected: 0 });
    expect(s.matched).toBeGreaterThanOrEqual(50);
    expect(s.audibleWindows).toBeGreaterThanOrEqual(10);
  });
});
