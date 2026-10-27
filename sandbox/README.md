# Sandbox: testing SeamScript against a mock backend

This directory holds one real-time frontend written only in SeamScript, connected to a mock backend with fault injection. It exists to check four things:

1. Whether you can really build a frontend in this language
2. Whether the IO parts (data that comes from outside) hold up against broken data and changes in shape
3. Whether, with real-time sync, the screen converges on the server's state under latency, jitter, reordering, loss and disconnects
4. Responsiveness, compared with a TypeScript + Zod version of the same app, Zod, Intl and tsc

A summary of the results is under [Results](#results). The decisions made and the lessons learned are in [DECISIONS.md](../DECISIONS.md), in the section on the mock-backend trial (`sandbox/`). The full benchmark tables are in [RESULTS.md](RESULTS.md).

## Running it

The tools are in the repository's `shell.nix`, and the browsers in `sandbox/e2e/shell.nix`. The latter is the former plus the Playwright browsers from nixpkgs (Chromium, Firefox, WebKit) and the Mesa that WebKit uses.

```bash
nix-shell sandbox/e2e/shell.nix --run 'yarn install --frozen-lockfile && yarn sandbox'
```

`yarn sandbox` builds the packages, runs the mock backend's unit tests, runs `seamc check` on the app and the voice sample, builds the apps, and runs the E2E tests (105 across 3 browsers, 7 of them skipped; see [Voice sample](#voice-sample)), in that order.

```bash
nix-shell sandbox/e2e/shell.nix --run 'yarn sandbox:bench'
```

This runs every benchmark, writes `results.json` and `report.md` to `sandbox/bench/results/`, and fails if any budget is exceeded. `node sandbox/bench/scripts/run.ts --quick` is a short version for CI. `--only latency` or `--browsers chromium` runs just part of it.

By default the benchmarks run in Chromium and WebKit (plus Node). Playwright's Firefox build runs WASM slowly and doesn't reflect the speed of the Firefox people actually use (on the same machine it is about 5× slower than Mozilla's official build of Firefox 157; see DECISIONS.md). `--browsers firefox` measures it for reference, but those numbers are not checked against the budgets. The E2E tests run in all 3 browsers.

To try the app by hand, start these two:

```bash
nix-shell --run 'node sandbox/backend/src/main.ts --port 8790'
```

```bash
nix-shell --run 'yarn workspace @seamscript-sandbox/app dev'
```

The dev server doesn't load the WASM core; the app runs on the browser's ICU (shown in the top-right corner of the screen). To see the production build, start the backend with `--static /=sandbox/app/dist` and open its port.

The voice sample runs the same way, with the backend from above: `nix-shell --run 'yarn workspace @seamscript-sandbox/voice dev'`, then open `/voice/` on the port Vite prints.

## Layout

| Path | Contents |
|---|---|
| `backend/` | The mock backend. Plain TS that runs as-is with Node's type stripping. Market simulation, HTTP and WebSocket, fault injection, an admin API, and serving the built app |
| `app/` | The SeamScript app (React 19 + Vite 8). Every source file is `.seam.ts` / `.seam.tsx` |
| `app-ts/` | The same app in TypeScript strict + Zod 4. Used only as the baseline for performance comparisons |
| `voice/` | A minimal voice round trip: microphone audio to the backend's WebSocket echo and back, played as it returns (see [Voice sample](#voice-sample)) |
| `e2e/` | Playwright E2E tests. Each worker starts its own backend and switches faults through the admin API |
| `bench/` | Benchmarks: decode and Text microbenchmarks (Node and 3 browsers), start-up time, latency, `seamc check` time, bundle size, budgets |

## The app

A dashboard for stock prices and orders, built for a high-frequency feed.

- **Price board**: 40 instruments, updated by trades over the WebSocket. When the board isn't real-time (disconnected, syncing, silent), values are dimmed and labelled "as of seq N"
- **Instrument search**: uses `latest`. Every keystroke sends a request, and only the newest answer is shown. Older requests are aborted, network request and all
- **Order entry**: quantity (Int64), price (Decimal), memo (`Text<NFC>`, up to 32 characters and 256 bytes). Sent with `NewOrder.encode`. On network errors and 5xx, the app resends with the same `clientOrderId`
- **Order list and details**: order IDs exceed 2^53. Details (the list of fills) are fetched with `latest`
- **Rejected data**: lists rejected frames and responses with the reason (path and expected type)

Where the added syntax is used:

| Syntax | Where |
|---|---|
| `boundary` | `api.seam.ts`: 15 of them. WS messages are `boundary ServerMessage = Hello \| Heartbeat \| Tick \| OrderEvent` |
| `decode` | WS frames (`decode string from e.data` → `JSON.parse` → `decode ServerMessage`), the snapshot, search, details, order responses, the form's quantity and price, the URL query |
| `latest` | Refetching the snapshot, search, order details |
| `Unknown` | The type that carries fetch responses and WS frames until they are decoded |
| Boundary types | IDs, quantities and seq (Int64), prices (Decimal), times (Zoned; displayed in Japan time), instrument names and memos (`Text<NFC>`; truncated for display on grapheme boundaries) |

### Sync design

The language guarantees two things: everything from outside goes through decode, and `latest` discards stale answers to overlapping requests. Stream ordering and convergence are the app's job (`feed.seam.ts`):

- Every event carries a server sequence number (seq) and is applied strictly in seq order. Events that arrive early are held; duplicates and stale ones are dropped
- When any of the following happens, the app refetches the snapshot and applies the held events that are newer than it:
  - a gap in seq stays unfilled for 400ms
  - a heartbeat shows that the server is ahead
  - events were missed across a reconnect
  - the server restarted (the epoch changed)
- If nothing arrives for 3.5 seconds, the connection is treated as dead even without a close, and the app reconnects with backoff
- Only the stream writes to the store. POST responses are used only to show "accepted"
- State updates on every message; notifications to the UI are batched to once per frame

## Voice sample

`voice/` is the smallest frontend of a real-time voice app: it sends microphone audio over a WebSocket and plays what comes back. The backend's `/voice/echo` endpoint returns every message as it is, so what is played is the microphone, delayed by the round trip and a 100 ms buffer. Use headphones.

Each WebSocket frame is a 4-byte little-endian sequence number followed by the samples. The page keeps a SHA-256 of each chunk's samples as sent, and compares it with the samples that come back under the same number. Everything played goes through an AnalyserNode, whose level is sampled every 50 ms while audio is scheduled.

- `src/capture.worklet.seam.ts` runs on the audio thread. The `inputs` of `process` are outside data (`Unknown`), so each block is decoded as `Planar<Float32, 1>` before it is used; before the microphone is connected the input has no channels, and the decode fails instead of the code reading `undefined`. The block is copied before it is posted, since the audio thread reuses its arrays.
- `src/main.seam.ts` decodes the microphone's actual settings (`MediaStreamTrack.getSettings()` is a source; Firefox doesn't report the sample rate, so the fields are optional), decodes each worklet block as `Pcm<Float32, 16000, 1>`, converts it to Int16 and sends 20 ms chunks with `Chunk.encode(Pcm.of(...))`.
- What comes back is decoded in two steps: the frame as `Bytes minLength 6 maxLength 3204`, then the samples after the number as `Pcm<Int16, 16000, 1> minLength 1 maxLength 1600`. A message that isn't one (a text frame, too few bytes, an odd number of sample bytes) is counted and shown with its `DecodeError` (`rule: "type"`, `"length"`, `"frameAlignment"`), and the stream goes on.

The page can talk to another echo server instead of the backend's, such as Throughline's Rust one: `/voice/?echo=ws://127.0.0.1:9000`. The parameter is outside data too, decoded as `string matches /^wss?:\/\/\S+$/`. The E2E tests take that address from `VOICE_ECHO_URL`:

```bash
nix-shell sandbox/e2e/shell.nix --run 'yarn --cwd sandbox/voice build && cd sandbox/e2e && VOICE_ECHO_URL=ws://127.0.0.1:9000 npx playwright test tests/voice.spec.ts'
```

The E2E tests (`e2e/tests/voice.spec.ts`) give Chromium and Firefox a fake microphone:

| Test | Passes when | Browsers |
|---|---|---|
| Round trip | at least 50 chunks came back with the same SHA-256 as sent under their number; every chunk received was compared, with none different, none under an unknown number and none rejected; and at least 10 output-level windows during playback had an RMS above 0.001 | Chromium |
| A changed chunk | flipping one byte of a chunk after it was hashed gives exactly one mismatch, and the chunks after it match again | Chromium |
| Rejection | a 3-byte frame, a frame with 3 bytes of samples, and a text frame are rejected with `length`, `frameAlignment` and `type`; a well-formed frame after them is accepted. An echo server that drops messages shorter than the sequence number and text messages, as Throughline's does, returns only the frame with 3 bytes of samples, which is rejected with `frameAlignment` | Chromium, Firefox |
| 15-second window | after streaming for a fixed 15 seconds, at least 50 chunks matched and 10 level windows were audible, with none different, none under an unknown number and none rejected. The counts are recorded as an annotation, to compare echo servers | Chromium |

The round trip can't pass on silence: with the microphone samples replaced by zeros, every hash still matches, and the test fails on the output level (0 audible windows). With Chromium's fake microphone (a periodic beep), a run sends about 80 chunks, all matched, and 10–12 of about 30 level windows are audible, with a peak RMS of 0.19. In this environment headless Firefox never starts an AudioContext (it stays `"suspended"` even after a click), and Playwright's WebKit build has no capture device at all, so the tests that need audio are skipped there with that reason.

## Mock backend

| | |
|---|---|
| `GET /api/snapshot` | All instruments and all orders, with the current seq and epoch |
| `GET /api/instruments?q=` | Instrument search (the query is compared without normalization; sent as NFD, it doesn't match) |
| `GET /api/orders/:id` | An order and its fills |
| `POST /api/orders` | Place an order. Idempotent on `clientOrderId`. The memo's characters are counted with the same WASM core as in the app |
| `POST /api/orders/:id/cancel` | Cancel |
| `WS /ws` | `hello`, `tick`, `order`, `heartbeat` |
| `/admin/*` | Fault settings (`faults`), market speed (`driver`), reset (new epoch), the authoritative state (`state`), statistics, forced disconnects, sending raw frames |

Faults are set by POSTing JSON to `/admin/faults`. Unknown keys and values of the wrong type are rejected, so a typo can't turn a test into one that tests nothing. The full list of settings is in `backend/src/faults.ts`. The randomness is seeded.

## E2E

Every scenario checks that:

- the page never throws an uncaught exception (0 `pageerror` events)
- after the faults stop, the app's state and the screen match the server's state (every instrument's value and version; every order's status, filled quantity, version and memo)
- a value on screen never goes back to an older version (a MutationObserver watches every DOM change)
- the app noticed the faults (counts of duplicates, gaps, rejections and so on) and shows the reasons

| File | Scenarios |
|---|---|
| `sync.spec.ts` | No faults, latency and jitter, reordering, duplicates, loss, broken JSON, binary frames, schema changes, alternative encodings of the same value, disconnects (with/without close), everything at once, server restart, a silent connection, a flood of events while the snapshot can't be fetched, the display while disconnected |
| `latest.spec.ts` | Search answers arriving in reverse order, NFD input, switching quickly between order details |
| `orders.spec.ts` | Int64, Decimal and Text round trips, a 500 after creation and the resend, rejection by the server, a memo with 300 combining characters, one grapheme of 100,000 characters |
| `core.spec.ts` | The WASM core runs in the production build, passes all of the official Unicode 17.0.0 test data, and halts when CSP forbids WASM; the build without the core |
| `scale.spec.ts` | 20,000 orders, 1 MB of extra fields, nesting 100,000 levels deep |

## Results

Intel Core i7-8550U (8 cores), Node 24.18, Chromium 149 / Firefox 151 / WebKit 26.5 (all headless, Playwright 1.61.1). E2E in 3 browsers; benchmarks in Chromium, WebKit and Node. Every comparison is a ratio to a baseline measured in the same run. The full tables are in [RESULTS.md](RESULTS.md).

### 1. Can you write a frontend in it? Yes

- The app is 1,515 lines of `.seam.ts` / `.seam.tsx` only (React 19 + Vite 8). `seamc check` passes, and introducing a violation stops it with SEAM2001 / SEAM2101.
- The production build runs on the WASM core (Unicode 17.0.0) in all 3 browsers. Inside the browser it passes all of the official Unicode 17.0.0 test data (766 grapheme cases, 20,034 normalization lines). On the same data, the browsers' own ICU passes everything in Chromium 149 and Firefox 151, but **WebKit 26.5 is at the level of Unicode 16** (graphemes 756/766, normalization 19,872/20,034).
- The same features take 1,260 lines in TS + Zod. The SeamScript version is longer because of validation the TS version doesn't do (Int64, Decimal, Zoned, Text normalization), the start-up check with `Text.status`, and the like.
- What the app needs beyond the five constructs lives in the runtime, not the syntax (`Decimal.add/sub/mul/div/round`, `Text.status`).
- **It works in the editor too**: a stock TS server reads `.seam.ts` as plain TS, so in this app 14 of 15 files show errors (151 syntax, 366 type) and type information is lost. With the tsserver plugin (`packages/ts-plugin`; in VS Code, the `packages/vscode` extension) the count drops to 0, and completion, type display, go to definition and rename work through `boundary` and `decode` (see the editor-support section of DECISIONS.md).

### 2. IO: broken data doesn't bring it down; it says why and catches up

The E2E suite is 31 scenarios × 3 browsers = 93 tests, and all of them pass. No scenario produces an uncaught exception in the page. After the faults stop, the app's state and the screen match the server's state, and no value on screen ever goes back to an older version.

- Broken JSON, binary frames and schema changes (UUID order IDs, numeric prices) are rejected with a reason (path, expected type, actual type). The gaps that the rejections leave are filled by the snapshot.
- Alternative encodings of the same value (numeric IDs, NFD, times in UTC or India time, trailing zeros) are read as the same value and not reported as problems.
- Order IDs above 2^53, quantities and prices stay exact in both directions. When a 500 comes back after the order was created, the app resends with the same `clientOrderId`, and there is still only one order.
- Client and server count the memo's characters with the same core. A memo of 14 copies of the Khmer "ស្ត្រី" is 14 characters under Unicode 17 and 42 under Unicode 16. Counted with Intl.Segmenter, it is 14 in Chromium and Firefox, **42 in WebKit**, and 42 on a server whose Node uses an older ICU (Unicode 16.0, as the nixpkgs build here does). Checking the 32-character limit with Intl would reject the input only in Safari, and the server would reject an order that Chrome accepted. With the core, all 3 browsers and the server agree on 14. When CSP forbids WASM, the app shows a halt screen instead of falling back to the browser's ICU.
- Large data: with a snapshot of 20,000 orders, it takes about 2.2 seconds from opening the page to going real-time. Nesting 100,000 levels deep gets through `JSON.parse` in all 3 browsers, and decode ignores it as an extra field. Typing one grapheme of 100,000 characters into the memo takes 0.4 to 1.3 seconds until the character count appears. The Text operations themselves take 70ms for `Text.nfc` and 28ms for `Text.length` in Node; the rest is the browser's input handling and rendering.

### 3. Real-time sync: converges under latency, reordering, loss and disconnects

- It converges under each of: latency and jitter, reordering, duplicates, loss, disconnects (with close / TCP only), server restarts, silence, and all of them at once. While disconnected or silent, values are labelled "as of seq N" and never presented as real-time.
- **State updates on every message; the UI is notified once per frame.** Rendering on every message saturates the main thread at around 1,000 messages per second and lets WebSocket messages pile up in the page's event queue. With per-frame notification, send to display stays at p95 25 to 30ms even at 2,000 messages per second. Lag is measured from the server's send time, because the app's own "server seq − applied seq" can't see messages still waiting in the event queue.
- The language guarantees only that everything goes through decode and that `latest` discards stale answers. Ordering and convergence are handled by the app's design (seq, holding, gap timeouts, heartbeats, snapshots). Nothing turned up that the language itself should add.

### 4. Responsiveness

| Item | Result (ratio to the baseline measured in the same run) |
|---|---|
| decode (Node) | 0.53–0.59× Zod with the same checks. 1.09–1.13× the TS app's plain Zod, which does no bigint conversion and no decimal, time or Text normalization |
| decode (browser) | 0.21–0.38× Zod with the same checks, 0.36–0.57× the TS app's plain Zod |
| Text.length (uncached) | 0.01–0.16× counting with Intl.Segmenter, in every environment and on every string. Japanese, ASCII and Latin text are answered in JS alone (0.01–0.04×); emoji and Khmer go through the WASM core's segmentation (0.09–0.16×; 0.15–0.22× against the official Node 24.18, whose ICU implements Unicode 17) |
| Text.slice(t, 0, 10) (uncached) | 0.01–0.30× iterating with Intl. On a 10KB string it processes only the first 10 graphemes (0.01–0.04×) |
| Text.nfc | 0.73–5.1× native `normalize`. Text answered in JS alone takes tens to hundreds of nanoseconds (0.73–3.3×); strings with characters that normalization can change (Khmer, Latin with combining characters) go through WASM's quick check and normalization (2.3–5.1×) |
| Server send to display | p95 ratio to the TS + Zod version: Chromium 0.86–1.03, WebKit 0.87–0.98. Decoding and applying one message takes 0.02–0.13ms in both |
| WASM core start-up cost | Time to the start of main becomes 1.04× in Chromium (+2.9ms) and 1.22× in WebKit (+8.4ms). `WebAssembly.instantiate` itself takes 0.9ms / 2.1ms |
| `seamc check` | 1.20× tsc on the same program. A `--watch` recheck takes about 1.3 seconds (the first check about 2.7 seconds) |
| Bundle (gzip) | 81.1KB without the core, 17KB smaller than the TS + Zod version (98.4KB). The core adds 90.5KB (171.5KB in total) |

The budgets (`bench/budgets.json`) hold the values above as ratios to baselines measured in the same run. CI runs them with `--quick` and fails if any budget is exceeded.
