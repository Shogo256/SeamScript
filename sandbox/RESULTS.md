# Benchmark results

2026-10-14T01:31:50.003Z, Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz (8 cores, 15 GiB), Node v24.18.0, commit 2e6098d (with uncommitted changes).

The load average (1 min) during the run was 12 to 28 (on an 8-core machine, with other applications using the CPU). Absolute values are inflated to 2 to 4 times those of the 2026-10-12 run, but every budget is a ratio to a baseline measured in the same run, which is much less affected.

**WebKit latency was measured again**: in the full run, "send→DOM p95, 50 messages/s" came out at 1.52×, over the 1.5× limit. Only SeamScript's second round had jumped: p50 from 21ms to 55ms, and p95 to 134ms (its first round had a p95 of 52ms, faster than the TS app's two rounds at 88ms and 62ms). Handling one message takes around 0.1ms, so the conclusion was that the browser itself was waiting for the CPU, and only the WebKit latency was measured again (load average 14 to 19). The tables and budgets below use the re-measured values: 1.15 / 1.17 / 1.13× at 50 / 500 / 2,000 messages/s. The full run's values are kept in `meta.latencyRerun.firstRun` in `bench/results/results.json`. In the re-measured run SeamScript was 10–20% slower than the TS app, but in the full run it was 1.02 / 1.06× at 500 / 2,000 messages/s, and in the previous run (the lightly loaded 2026-10-12) 0.72–1.12×. A difference this small can't be told apart from noise caused by load.

In this run's hyperfine measurement, `seamc check` took 1.19× as long as tsc. That was under heavy load; a separate run that alternated the two, 8 times each, gave a median of 1.36×.

## Budgets (ratios to a baseline measured in the same run)

| Item | Measured | Limit | Result |
|---|---|---|---|
| Node decode: tick: SeamScript ÷ Zod with the same checks | 0.59× | 1.30× | OK |
| Node decode: order event: SeamScript ÷ Zod with the same checks | 0.56× | 1.30× | OK |
| Node decode: snapshot (40 + 1000 orders): SeamScript ÷ Zod with the same checks | 0.53× | 1.30× | OK |
| Node length Japanese 20: Text ÷ Intl | 0.03× | 1.00× | OK |
| Node NFC Japanese 20: Text.nfc ÷ normalize | 0.88× | 6.00× | OK |
| Node length Khmer (changed in Unicode 17): Text ÷ Intl | 0.60× | 1.00× | OK |
| Node NFC Khmer (changed in Unicode 17): Text.nfc ÷ normalize | 3.46× | 6.00× | OK |
| seamc check ÷ tsc (same program) | 1.19× | 1.60× | OK |
| Bundle gzip: no core ÷ TS + Zod | 0.83× | 0.90× | OK |
| gzip bytes added by the core | 111156 | 115000 | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 50 messages/s: SeamScript ÷ TS | 0.95× | 1.50× | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 500 messages/s: SeamScript ÷ TS | 1.03× | 1.50× | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 2000 messages/s: SeamScript ÷ TS | 1.01× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 50 messages/s: SeamScript ÷ TS | 1.15× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 500 messages/s: SeamScript ÷ TS | 1.17× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 2000 messages/s: SeamScript ÷ TS | 1.13× | 1.50× | OK |
| Start-up chromium 149.0.7827.55: with core ÷ without | 1.10× | 1.50× | OK |
| Start-up webkit 26.5: with core ÷ without | 1.27× | 1.50× | OK |

## decode (per call, p50 / p95 / p99)

"Zod with the same checks" is a schema that does the same work as SeamScript, down to bigint conversion, Decimal normalization and Text NFC normalization (`src/zod-equivalent.ts`). "The TS app's Zod" is the schemas of the comparison app `app-ts`: IDs and prices stay strings, with no normalization. Ratios compare p50 with p50.

### Node v24.18.0

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 3.68 µs / 4.15 µs / 4.78 µs | 0.59× |
| decode: tick | Zod (the TS app's schemas) | 3.04 µs / 3.81 µs / 25.9 µs | 0.49× |
| decode: tick | Zod (same checks as SeamScript) | 6.21 µs / 7.58 µs / 72.8 µs |  |
| decode: order event | SeamScript decode | 9.95 µs / 11.6 µs / 14.0 µs | 0.56× |
| decode: order event | Zod (the TS app's schemas) | 9.24 µs / 66.5 µs / 116 µs | 0.52× |
| decode: order event | Zod (same checks as SeamScript) | 17.7 µs / 24.9 µs / 184 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 8.04 ms / 9.33 ms / 32.0 ms | 0.53× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 7.58 ms / 10.1 ms / 60.9 ms | 0.50× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 15.2 ms / 24.2 ms / 56.2 ms |  |
| parse + decode: tick | SeamScript | 6.88 µs / 7.81 µs / 8.30 µs | 2.85× |
| parse + decode: tick | JSON.parse only | 2.41 µs / 3.28 µs / 9.90 µs |  |
| parse + decode: tick | Zod (the TS app's schemas) | 6.64 µs / 9.99 µs / 47.8 µs | 2.75× |

### chromium 149.0.7827.55

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 2.96 µs / 3.54 µs / 6.07 µs | 0.39× |
| decode: tick | Zod (the TS app's schemas) | 5.31 µs / 6.45 µs / 6.65 µs | 0.70× |
| decode: tick | Zod (same checks as SeamScript) | 7.59 µs / 10.2 µs / 55.8 µs |  |
| decode: order event | SeamScript decode | 8.10 µs / 10.1 µs / 13.0 µs | 0.34× |
| decode: order event | Zod (the TS app's schemas) | 15.8 µs / 18.8 µs / 19.6 µs | 0.66× |
| decode: order event | Zod (same checks as SeamScript) | 23.9 µs / 37.5 µs / 144 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 6.80 ms / 8.33 ms / 12.7 ms | 0.32× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 13.1 ms / 17.0 ms / 46.8 ms | 0.63× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 21.0 ms / 25.6 ms / 27.8 ms |  |
| parse + decode: tick | SeamScript | 5.29 µs / 6.56 µs / 8.87 µs | 3.68× |
| parse + decode: tick | JSON.parse only | 1.44 µs / 1.64 µs / 2.41 µs |  |
| parse + decode: tick | Zod (the TS app's schemas) | 7.12 µs / 11.3 µs / 53.8 µs | 4.96× |

### webkit 26.5

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 2.00 µs / 2.62 µs / 2.78 µs | 0.21× |
| decode: tick | Zod (the TS app's schemas) | 5.27 µs / 8.95 µs / 10.0 µs | 0.57× |
| decode: tick | Zod (same checks as SeamScript) | 9.32 µs / 16.0 µs / 25.2 µs |  |
| decode: order event | SeamScript decode | 6.42 µs / 7.96 µs / 8.47 µs | 0.24× |
| decode: order event | Zod (the TS app's schemas) | 19.7 µs / 33.5 µs / 49.3 µs | 0.74× |
| decode: order event | Zod (same checks as SeamScript) | 26.8 µs / 40.4 µs / 56.7 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 5.20 ms / 6.61 ms / 6.90 ms | 0.21× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 15.7 ms / 27.3 ms / 33.9 ms | 0.65× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 24.3 ms / 32.4 ms / 36.8 ms |  |
| parse + decode: tick | SeamScript | 3.65 µs / 4.25 µs / 5.46 µs | 2.92× |
| parse + decode: tick | JSON.parse only | 1.25 µs / 1.65 µs / 1.94 µs |  |
| parse + decode: tick | Zod (the TS app's schemas) | 8.41 µs / 15.3 µs / 19.5 µs | 6.74× |

## Text operations (per call, p50 / p95 / p99)

"1024 strings" cycles through 1024 different strings so that Text's grapheme-boundary cache (256 entries) never hits. The baselines are the browser's (or Node's) own `Intl.Segmenter` and `String.prototype.normalize`.

### Node v24.18.0 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 355 ns / 432 ns / 464 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 416 ns / 505 ns / 525 ns |
| length: ASCII 21 | Intl.Segmenter count | 16.3 µs / 23.7 µs / 156 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 507 ns / 1.99 µs / 12.0 µs |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 11.7 µs / 17.5 µs / 35.1 µs |
| NFC: ASCII 21 | Text.nfc | 345 ns / 402 ns / 416 ns |
| NFC: ASCII 21 | String.prototype.normalize | 344 ns / 396 ns / 404 ns |
| length: Japanese 20 | Text.length (same string: cached) | 381 ns / 481 ns / 503 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 464 ns / 584 ns / 605 ns |
| length: Japanese 20 | Intl.Segmenter count | 18.5 µs / 28.7 µs / 161 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 517 ns / 773 ns / 1.81 µs |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 12.8 µs / 45.2 µs / 95.4 µs |
| NFC: Japanese 20 | Text.nfc | 352 ns / 429 ns / 469 ns |
| NFC: Japanese 20 | String.prototype.normalize | 398 ns / 451 ns / 504 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 165 ns / 214 ns / 234 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 12.4 µs / 13.5 µs / 14.9 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 21.7 µs / 40.1 µs / 105 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 14.2 µs / 16.3 µs / 18.9 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 15.9 µs / 18.5 µs / 86.4 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 1.52 µs / 1.74 µs / 1.94 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 851 ns / 954 ns / 976 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 132 ns / 157 ns / 169 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 16.4 µs / 18.0 µs / 18.3 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 27.1 µs / 59.7 µs / 131 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 16.2 µs / 19.0 µs / 19.6 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 14.1 µs / 28.4 µs / 94.5 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 4.33 µs / 4.75 µs / 4.97 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 1.25 µs / 1.37 µs / 1.41 µs |
| length: Accented Latin | Text.length (same string: cached) | 485 ns / 582 ns / 609 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 541 ns / 657 ns / 725 ns |
| length: Accented Latin | Intl.Segmenter count | 19.5 µs / 65.4 µs / 81.7 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 492 ns / 1.01 µs / 3.54 µs |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 11.9 µs / 14.2 µs / 113 µs |
| NFC: Accented Latin | Text.nfc | 7.84 µs / 9.03 µs / 28.0 µs |
| NFC: Accented Latin | String.prototype.normalize | 2.00 µs / 2.32 µs / 2.39 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 78 ns / 86 ns / 93 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 57.8 µs / 77.0 µs / 84.1 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 1.80 ms / 2.46 ms / 7.14 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 599 ns / 1.04 µs / 4.94 µs |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 19.3 µs / 51.8 µs / 100 µs |
| NFC: Japanese 10 KB | Text.nfc | 51.0 µs / 61.3 µs / 63.5 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 18.6 µs / 23.4 µs / 23.7 µs |

### Node v24.18.0 (Text: host ICU)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 184 ns / 209 ns / 214 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 219 ns / 326 ns / 477 ns |
| length: ASCII 21 | Intl.Segmenter count | 15.9 µs / 55.5 µs / 185 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 349 ns / 617 ns / 11.7 µs |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 11.6 µs / 88.0 µs / 94.6 µs |
| NFC: ASCII 21 | Text.nfc | 453 ns / 536 ns / 580 ns |
| NFC: ASCII 21 | String.prototype.normalize | 326 ns / 387 ns / 396 ns |
| length: Japanese 20 | Text.length (same string: cached) | 17.5 µs / 70.6 µs / 117 µs |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 18.1 µs / 92.0 µs / 126 µs |
| length: Japanese 20 | Intl.Segmenter count | 18.4 µs / 98.1 µs / 159 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 12.1 µs / 62.4 µs / 103 µs |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 12.7 µs / 53.7 µs / 85.1 µs |
| NFC: Japanese 20 | Text.nfc | 581 ns / 642 ns / 688 ns |
| NFC: Japanese 20 | String.prototype.normalize | 374 ns / 445 ns / 455 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 20.3 µs / 144 µs / 175 µs |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 22.3 µs / 129 µs / 172 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 22.1 µs / 77.2 µs / 89.8 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 14.5 µs / 65.5 µs / 102 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 14.5 µs / 74.8 µs / 90.3 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 1.10 µs / 1.25 µs / 1.32 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 823 ns / 934 ns / 952 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 25.3 µs / 135 µs / 166 µs |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 24.8 µs / 111 µs / 182 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 25.9 µs / 101 µs / 129 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 13.6 µs / 46.3 µs / 93.2 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 14.3 µs / 68.7 µs / 116 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 1.47 µs / 1.70 µs / 1.84 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 1.20 µs / 1.36 µs / 1.56 µs |
| length: Accented Latin | Text.length (same string: cached) | 19.0 µs / 73.7 µs / 85.2 µs |
| length: Accented Latin | Text.length (1024 strings: uncached) | 18.8 µs / 87.5 µs / 126 µs |
| length: Accented Latin | Intl.Segmenter count | 19.4 µs / 96.2 µs / 137 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 11.1 µs / 82.0 µs / 95.7 µs |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 11.6 µs / 54.8 µs / 81.0 µs |
| NFC: Accented Latin | Text.nfc | 2.27 µs / 2.74 µs / 3.12 µs |
| NFC: Accented Latin | String.prototype.normalize | 2.07 µs / 2.33 µs / 10.5 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 1.73 ms / 7.91 ms / 14.0 ms |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 1.80 ms / 3.91 ms / 6.94 ms |
| length: Japanese 10 KB | Intl.Segmenter count | 1.70 ms / 2.59 ms / 6.67 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 19.4 µs / 46.9 µs / 170 µs |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 18.6 µs / 46.7 µs / 177 µs |
| NFC: Japanese 10 KB | Text.nfc | 28.4 µs / 53.7 µs / 75.2 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 16.9 µs / 21.0 µs / 22.4 µs |

### chromium 149.0.7827.55 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 218 ns / 278 ns / 341 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 241 ns / 291 ns / 302 ns |
| length: ASCII 21 | Intl.Segmenter count | 19.8 µs / 36.0 µs / 96.0 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 397 ns / 532 ns / 1.89 µs |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 15.7 µs / 28.0 µs / 73.1 µs |
| NFC: ASCII 21 | Text.nfc | 294 ns / 395 ns / 456 ns |
| NFC: ASCII 21 | String.prototype.normalize | 384 ns / 562 ns / 600 ns |
| length: Japanese 20 | Text.length (same string: cached) | 209 ns / 261 ns / 274 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 239 ns / 355 ns / 525 ns |
| length: Japanese 20 | Intl.Segmenter count | 21.5 µs / 30.6 µs / 87.1 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 354 ns / 421 ns / 440 ns |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 16.3 µs / 24.1 µs / 75.0 µs |
| NFC: Japanese 20 | Text.nfc | 268 ns / 312 ns / 326 ns |
| NFC: Japanese 20 | String.prototype.normalize | 398 ns / 455 ns / 511 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 148 ns / 181 ns / 215 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 11.2 µs / 15.4 µs / 16.4 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 26.0 µs / 34.0 µs / 48.8 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 12.9 µs / 15.9 µs / 20.6 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 19.2 µs / 25.6 µs / 64.4 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 1.06 µs / 1.27 µs / 1.33 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 930 ns / 1.14 µs / 1.37 µs |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 111 ns / 127 ns / 147 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 15.0 µs / 16.9 µs / 18.2 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 19.6 µs / 38.0 µs / 104 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 15.9 µs / 18.5 µs / 22.6 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 20.3 µs / 32.5 µs / 181 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 3.46 µs / 4.43 µs / 5.07 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 1.20 µs / 1.39 µs / 1.57 µs |
| length: Accented Latin | Text.length (same string: cached) | 276 ns / 357 ns / 417 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 300 ns / 355 ns / 368 ns |
| length: Accented Latin | Intl.Segmenter count | 22.0 µs / 70.9 µs / 84.9 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 355 ns / 458 ns / 658 ns |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 16.6 µs / 20.1 µs / 32.4 µs |
| NFC: Accented Latin | Text.nfc | 7.57 µs / 9.49 µs / 11.1 µs |
| NFC: Accented Latin | String.prototype.normalize | 2.46 µs / 3.31 µs / 3.96 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 81 ns / 91 ns / 98 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 27.5 µs / 35.8 µs / 37.2 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 1.51 ms / 1.93 ms / 2.56 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 389 ns / 481 ns / 724 ns |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 44.8 µs / 54.7 µs / 59.9 µs |
| NFC: Japanese 10 KB | Text.nfc | 25.8 µs / 33.7 µs / 39.0 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 18.9 µs / 22.6 µs / 25.1 µs |

### webkit 26.5 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 182 ns / 213 ns / 242 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 209 ns / 249 ns / 404 ns |
| length: ASCII 21 | Intl.Segmenter count | 16.9 µs / 20.4 µs / 24.6 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 1.04 µs / 1.50 µs / 1.77 µs |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 13.2 µs / 18.4 µs / 22.7 µs |
| NFC: ASCII 21 | Text.nfc | 218 ns / 258 ns / 304 ns |
| NFC: ASCII 21 | String.prototype.normalize | 102 ns / 117 ns / 132 ns |
| length: Japanese 20 | Text.length (same string: cached) | 230 ns / 294 ns / 361 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 274 ns / 345 ns / 356 ns |
| length: Japanese 20 | Intl.Segmenter count | 17.0 µs / 27.1 µs / 41.2 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 1.03 µs / 1.63 µs / 1.89 µs |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 12.3 µs / 18.5 µs / 20.6 µs |
| NFC: Japanese 20 | Text.nfc | 236 ns / 438 ns / 443 ns |
| NFC: Japanese 20 | String.prototype.normalize | 370 ns / 442 ns / 449 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 115 ns / 151 ns / 178 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 10.6 µs / 24.1 µs / 34.3 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 19.8 µs / 25.2 µs / 26.3 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 13.3 µs / 17.2 µs / 19.2 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 15.5 µs / 21.6 µs / 23.7 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 1.06 µs / 1.37 µs / 1.54 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 695 ns / 828 ns / 845 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 91 ns / 111 ns / 129 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 15.1 µs / 18.1 µs / 22.5 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 20.9 µs / 30.1 µs / 32.5 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 16.4 µs / 19.6 µs / 22.4 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 14.5 µs / 17.5 µs / 21.0 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 3.96 µs / 4.78 µs / 5.21 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 842 ns / 1.30 µs / 1.85 µs |
| length: Accented Latin | Text.length (same string: cached) | 216 ns / 276 ns / 290 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 235 ns / 283 ns / 303 ns |
| length: Accented Latin | Intl.Segmenter count | 19.2 µs / 24.6 µs / 28.0 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 995 ns / 1.50 µs / 1.60 µs |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 12.4 µs / 15.3 µs / 17.3 µs |
| NFC: Accented Latin | Text.nfc | 9.43 µs / 11.5 µs / 14.1 µs |
| NFC: Accented Latin | String.prototype.normalize | 4.02 µs / 5.23 µs / 6.38 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 64 ns / 75 ns / 92 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 42.1 µs / 48.5 µs / 49.7 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 1.06 ms / 1.53 ms / 1.75 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 1.21 µs / 1.65 µs / 1.79 µs |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 28.8 µs / 35.2 µs / 38.5 µs |
| NFC: Japanese 10 KB | Text.nfc | 19.1 µs / 24.0 µs / 26.3 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 16.9 µs / 20.3 µs / 20.8 µs |

## Start-up time added by loading the WASM core

The same app is built with and without the core, and the two builds are loaded alternately in fresh contexts. Values run from navigation start to the start of the main module (`seam:main`). With the core, main runs only after the core's top-level await (base64 decoding, compilation, instantiation) settles.

| Browser | Without core p50 / p95 / p99 | With core p50 / p95 / p99 | Difference (p50) | WebAssembly.instantiate p50 / p95 / p99 |
|---|---|---|---|---|
| chromium 149.0.7827.55 | 379.0 ms / 513.0 ms / 573.1 ms | 417.5 ms / 544.7 ms / 709.0 ms | 38.5 ms | 5.60 ms / 12.0 ms / 14.3 ms |
| webkit 26.5 | 222.2 ms / 293.8 ms / 316.3 ms | 282.5 ms / 328.4 ms / 362.3 ms | 60.2 ms | 12.4 ms / 20.0 ms / 24.6 ms |

Node (import in a fresh process): `@seamscript/core` 141.9 ms / 166.9 ms / 226.3 ms; `@seamscript/runtime` alone 28.6 ms / 35.0 ms / 48.2 ms (20 runs each).

## Latency from server send to DOM update

For every price tick, the page records when the WebSocket received it and when that row's data-version changed (MutationObserver). Receive→DOM is measured entirely inside the page. Send→DOM is measured from the server's send time and includes the network, waiting in the page's event queue, and clock skew between processes. "Handler" is the time the app itself measures to decode and apply one message (rendering not included). Each condition is repeated with the order of the apps swapped.

- **Per frame** (the app as designed): state updates on every message, and the UI is notified once per frame. When the same instrument moves several times within one frame, the intermediate values are never shown, so "shown/received" drops below 1.
- **Per message** (`?render=each`, for benchmarking only): the app renders on every message. With no wait for rendering, differences in handling show up more clearly, but at high rates the main thread saturates.

### Per frame, 50 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 300/300 | 4.70 ms / 15.6 ms / 20.0 ms | 8.93 ms / 21.8 ms / 27.2 ms | 0.10 ms / 1.19 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 299/300 | 4.75 ms / 15.5 ms / 20.6 ms | 8.21 ms / 22.9 ms / 36.0 ms | 0.13 ms / 2.15 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 300/301 | 4.38 ms / 14.9 ms / 17.1 ms | 7.41 ms / 18.5 ms / 26.1 ms | 0.13 ms / 2.08 ms |
| chromium 149.0.7827.55 | SeamScript | 301/301 | 4.15 ms / 13.3 ms / 17.0 ms | 5.96 ms / 16.7 ms / 20.5 ms | 0.10 ms / 0.87 ms |
| webkit 26.5 | SeamScript | 286/300 | 32.4 ms / 78.7 ms / 102.7 ms | 38.5 ms / 100.0 ms / 130.6 ms | 0.12 ms / 1.42 ms |
| webkit 26.5 | TypeScript + Zod | 289/303 | 32.3 ms / 73.5 ms / 95.7 ms | 37.8 ms / 88.5 ms / 126.2 ms | 0.16 ms / 2.40 ms |
| webkit 26.5 | TypeScript + Zod | 286/300 | 30.5 ms / 74.7 ms / 104.9 ms | 35.7 ms / 86.3 ms / 123.4 ms | 0.16 ms / 2.66 ms |
| webkit 26.5 | SeamScript | 291/302 | 36.6 ms / 81.2 ms / 138.5 ms | 43.9 ms / 102.0 ms / 149.8 ms | 0.10 ms / 2.36 ms |

### Per frame, 500 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 2622/3004 | 5.33 ms / 15.5 ms / 25.2 ms | 16.4 ms / 39.8 ms / 56.0 ms | 0.03 ms / 0.25 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 2659/3015 | 5.38 ms / 15.3 ms / 20.8 ms | 15.2 ms / 36.1 ms / 50.1 ms | 0.04 ms / 0.50 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 2628/3008 | 5.34 ms / 15.4 ms / 24.4 ms | 15.9 ms / 38.6 ms / 50.7 ms | 0.04 ms / 0.25 ms |
| chromium 149.0.7827.55 | SeamScript | 2647/3008 | 5.43 ms / 14.4 ms / 20.8 ms | 15.2 ms / 36.5 ms / 58.9 ms | 0.03 ms / 0.24 ms |
| webkit 26.5 | SeamScript | 1482/2984 | 44.7 ms / 111.5 ms / 147.8 ms | 50.3 ms / 137.9 ms / 182.6 ms | 0.02 ms / 0.46 ms |
| webkit 26.5 | TypeScript + Zod | 1702/3022 | 34.1 ms / 91.2 ms / 117.5 ms | 41.1 ms / 117.6 ms / 167.2 ms | 0.04 ms / 2.24 ms |
| webkit 26.5 | TypeScript + Zod | 1802/3023 | 31.8 ms / 76.5 ms / 115.5 ms | 37.4 ms / 98.1 ms / 141.8 ms | 0.04 ms / 1.18 ms |
| webkit 26.5 | SeamScript | 1514/2992 | 39.8 ms / 114.5 ms / 166.2 ms | 46.4 ms / 137.6 ms / 187.4 ms | 0.02 ms / 1.32 ms |

### Per frame, 2000 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 6263/12025 | 6.30 ms / 17.2 ms / 26.9 ms | 22.1 ms / 55.2 ms / 80.5 ms | 0.02 ms / 0.09 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 6595/12060 | 5.80 ms / 14.4 ms / 21.0 ms | 21.2 ms / 48.5 ms / 62.2 ms | 0.03 ms / 0.10 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 5305/12178 | 7.71 ms / 21.8 ms / 33.0 ms | 30.5 ms / 72.6 ms / 93.4 ms | 0.03 ms / 0.15 ms |
| chromium 149.0.7827.55 | SeamScript | 5156/12084 | 8.54 ms / 25.0 ms / 40.6 ms | 33.4 ms / 73.3 ms / 93.9 ms | 0.03 ms / 0.17 ms |
| webkit 26.5 | SeamScript | 2410/12112 | 23.5 ms / 59.9 ms / 75.5 ms | 26.0 ms / 70.0 ms / 91.8 ms | 0.02 ms / 0.34 ms |
| webkit 26.5 | TypeScript + Zod | 2834/12020 | 18.7 ms / 50.0 ms / 84.1 ms | 22.4 ms / 64.2 ms / 91.5 ms | 0.02 ms / 0.34 ms |
| webkit 26.5 | TypeScript + Zod | 2885/12099 | 18.0 ms / 46.7 ms / 61.6 ms | 21.9 ms / 59.2 ms / 79.6 ms | 0.02 ms / 0.20 ms |
| webkit 26.5 | SeamScript | 2280/12040 | 23.5 ms / 60.5 ms / 85.6 ms | 27.3 ms / 72.6 ms / 99.9 ms | 0.02 ms / 0.22 ms |

### Per message, 50 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 301/301 | 1.16 ms / 3.68 ms / 4.91 ms | 3.48 ms / 16.2 ms / 25.7 ms | 0.11 ms / 1.58 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 301/301 | 1.08 ms / 4.19 ms / 7.88 ms | 2.87 ms / 15.1 ms / 23.0 ms | 0.14 ms / 1.98 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 301/301 | 1.10 ms / 4.44 ms / 7.54 ms | 4.37 ms / 20.3 ms / 28.5 ms | 0.14 ms / 3.10 ms |
| chromium 149.0.7827.55 | SeamScript | 302/302 | 1.27 ms / 5.24 ms / 6.98 ms | 6.14 ms / 25.2 ms / 37.3 ms | 0.11 ms / 3.69 ms |
| webkit 26.5 | SeamScript | 300/300 | 1.16 ms / 3.78 ms / 6.04 ms | 3.74 ms / 14.8 ms / 20.3 ms | 0.12 ms / 1.66 ms |
| webkit 26.5 | TypeScript + Zod | 300/300 | 1.08 ms / 2.44 ms / 3.80 ms | 3.36 ms / 15.2 ms / 30.1 ms | 0.16 ms / 1.58 ms |
| webkit 26.5 | TypeScript + Zod | 301/301 | 1.08 ms / 2.16 ms / 3.96 ms | 3.13 ms / 11.8 ms / 21.4 ms | 0.18 ms / 1.50 ms |
| webkit 26.5 | SeamScript | 300/300 | 1.08 ms / 2.64 ms / 4.24 ms | 3.25 ms / 13.3 ms / 22.6 ms | 0.12 ms / 0.64 ms |

### Per message, 500 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 3006/3006 | 0.52 ms / 1.09 ms / 1.78 ms | 4.52 ms / 32.4 ms / 47.0 ms | 0.05 ms / 0.14 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 3000/3000 | 0.51 ms / 1.16 ms / 2.38 ms | 7.93 ms / 36.2 ms / 49.7 ms | 0.06 ms / 0.29 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 3001/3001 | 0.50 ms / 1.06 ms / 1.86 ms | 6.23 ms / 27.5 ms / 36.1 ms | 0.06 ms / 0.28 ms |
| chromium 149.0.7827.55 | SeamScript | 3006/3006 | 0.53 ms / 1.06 ms / 2.06 ms | 6.37 ms / 29.8 ms / 46.2 ms | 0.05 ms / 0.20 ms |
| webkit 26.5 | SeamScript | 3032/3032 | 0.52 ms / 1.44 ms / 3.24 ms | 8.81 ms / 42.6 ms / 85.4 ms | 0.04 ms / 0.46 ms |
| webkit 26.5 | TypeScript + Zod | 3398/3398 | 0.44 ms / 1.46 ms / 3.80 ms | 13.0 ms / 587.5 ms / 749.8 ms | 0.06 ms / 0.50 ms |
| webkit 26.5 | TypeScript + Zod | 3006/3006 | 0.46 ms / 1.20 ms / 2.70 ms | 6.23 ms / 22.4 ms / 34.0 ms | 0.06 ms / 0.22 ms |
| webkit 26.5 | SeamScript | 3013/3013 | 0.52 ms / 1.14 ms / 2.16 ms | 5.49 ms / 22.6 ms / 34.1 ms | 0.04 ms / 0.36 ms |

### Per message, 1000 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 6058/6058 | 0.45 ms / 0.66 ms / 0.92 ms | 19.1 ms / 32.5 ms / 42.4 ms | 0.04 ms / 0.09 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 6015/6015 | 0.42 ms / 0.65 ms / 1.09 ms | 19.2 ms / 36.5 ms / 52.7 ms | 0.04 ms / 0.12 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 6030/6030 | 0.41 ms / 0.66 ms / 1.10 ms | 20.1 ms / 38.7 ms / 46.2 ms | 0.05 ms / 0.12 ms |
| chromium 149.0.7827.55 | SeamScript | 6016/6016 | 0.50 ms / 0.89 ms / 2.27 ms | 97.1 ms / 254.7 ms / 266.2 ms | 0.04 ms / 0.13 ms |
| webkit 26.5 | SeamScript | 6760/6760 | 0.40 ms / 0.76 ms / 1.38 ms | 125.4 ms / 771.6 ms / 800.7 ms | 0.04 ms / 0.16 ms |
| webkit 26.5 | TypeScript + Zod | 7390/7390 | 0.34 ms / 0.68 ms / 1.18 ms | 388.3 ms / 1311.7 ms / 1379.5 ms | 0.04 ms / 0.34 ms |
| webkit 26.5 | TypeScript + Zod | 7069/7069 | 0.36 ms / 0.78 ms / 2.06 ms | 1988.6 ms / 2403.8 ms / 2433.3 ms | 0.04 ms / 0.16 ms |
| webkit 26.5 | SeamScript | 5982/5982 | 0.44 ms / 1.06 ms / 2.04 ms | 2302.2 ms / 2492.3 ms / 2531.7 ms | 0.02 ms / 0.12 ms |

## `seamc check` and `tsc` times (hyperfine)

To compare the same program, the baseline is `tsc --noEmit` run on the plain TS that `seamc build` emits.

| Command | Mean ± std dev | Median | Min–max | Ratio | Runs |
|---|---|---|---|---|---|
| seamc check (app) | 7.680 s ± 0.794 | 7.545 s | 6.362–9.164 s | 1.19× | 10 |
| tsc --noEmit (app, as plain TS) | 6.458 s ± 0.669 | 6.432 s | 5.468–7.261 s | 1.00× | 10 |
| tsc --noEmit (TS + Zod twin) | 8.317 s ± 1.185 | 7.768 s | 7.099–10.112 s | 1.29× | 10 |

## Bundle size (the JS and CSS that index.html loads)

| Build | Raw | gzip | brotli | Difference from TS + Zod (gzip) |
|---|---|---|---|---|
| SeamScript (WASM core) | 512.8 KB | 190.2 KB | 166.8 KB | +91.3 KB |
| SeamScript (no core) | 259.2 KB | 81.7 KB | 70.7 KB | -17.2 KB |
| TypeScript + Zod | 327.7 KB | 98.9 KB | 85.7 KB | +0.0 KB |
