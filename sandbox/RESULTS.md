# Benchmark results

2026-10-14T05:32:32.592Z, Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz (8 cores, 15 GiB), Node v24.18.0 (ICU 76.1, Unicode 16.0), commit b1a75a2 (with uncommitted changes).

Load average (1 min) at the start and end of the run: 7.0, 1.4. Absolute values move a lot when other programs are using the CPU; ratios are much less affected.

Node here is the nixpkgs build, linked against the system ICU 76.1. Official Node builds bundle ICU 78.3 (Unicode 17.0), whose `Intl.Segmenter` counts the Khmer sample as 10 graphemes instead of 30 and is faster for it. With the official Node 24.18.0 on the same machine, `Text.length` (uncached) is 0.22× `Intl.Segmenter` for Khmer and 0.15× for the emoji sample. CI runs on official Node.

## Budgets (ratios to a baseline measured in the same run)

| Item | Measured | Limit | Result |
|---|---|---|---|
| Node decode: tick: SeamScript ÷ Zod with the same checks | 0.56× | 1.30× | OK |
| Node decode: order event: SeamScript ÷ Zod with the same checks | 0.59× | 1.30× | OK |
| Node decode: snapshot (40 + 1000 orders): SeamScript ÷ Zod with the same checks | 0.53× | 1.30× | OK |
| Node length Japanese 20: Text ÷ Intl | 0.02× | 1.00× | OK |
| Node NFC Japanese 20: Text.nfc ÷ normalize | 0.88× | 6.00× | OK |
| Node length Khmer (changed in Unicode 17): Text ÷ Intl | 0.12× | 1.00× | OK |
| Node NFC Khmer (changed in Unicode 17): Text.nfc ÷ normalize | 3.04× | 6.00× | OK |
| seamc check ÷ tsc (same program) | 1.20× | 1.60× | OK |
| Bundle gzip: no core ÷ TS + Zod | 0.82× | 0.90× | OK |
| gzip bytes added by the core | 92650 | 115000 | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 50 messages/s: SeamScript ÷ TS | 0.86× | 1.50× | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 500 messages/s: SeamScript ÷ TS | 1.02× | 1.50× | OK |
| Latency (send→DOM) p95 chromium 149.0.7827.55 2000 messages/s: SeamScript ÷ TS | 1.03× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 50 messages/s: SeamScript ÷ TS | 0.87× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 500 messages/s: SeamScript ÷ TS | 0.98× | 1.50× | OK |
| Latency (send→DOM) p95 webkit 26.5 2000 messages/s: SeamScript ÷ TS | 0.94× | 1.50× | OK |
| Start-up chromium 149.0.7827.55: with core ÷ without | 1.04× | 1.50× | OK |
| Start-up webkit 26.5: with core ÷ without | 1.22× | 1.50× | OK |

## decode (per call, p50 / p95 / p99)

"Zod with the same checks" is a schema that does the same work as SeamScript, down to bigint conversion, Decimal normalization and Text NFC normalization (`src/zod-equivalent.ts`). "The TS app's Zod" is the schemas of the comparison app `app-ts`: IDs and prices stay strings, with no normalization. Ratios compare p50 with p50.

### Node v24.18.0

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 1.18 µs / 1.63 µs / 15.1 µs | 0.56× |
| decode: tick | Zod (the TS app's schemas) | 1.05 µs / 1.34 µs / 4.86 µs | 0.49× |
| decode: tick | Zod (same checks as SeamScript) | 2.13 µs / 2.46 µs / 12.0 µs |  |
| decode: order event | SeamScript decode | 3.22 µs / 4.03 µs / 30.7 µs | 0.59× |
| decode: order event | Zod (the TS app's schemas) | 2.92 µs / 3.47 µs / 11.9 µs | 0.53× |
| decode: order event | Zod (same checks as SeamScript) | 5.50 µs / 6.69 µs / 11.0 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 2.74 ms / 3.22 ms / 8.84 ms | 0.53× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 2.51 ms / 3.87 ms / 16.6 ms | 0.49× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 5.18 ms / 9.92 ms / 44.1 ms |  |
| parse + decode: tick | SeamScript | 2.42 µs / 2.77 µs / 10.4 µs | 2.89× |
| parse + decode: tick | JSON.parse only | 836 ns / 1.05 µs / 4.08 µs |  |
| parse + decode: tick | Zod (the TS app's schemas) | 2.14 µs / 5.18 µs / 19.1 µs | 2.56× |

### chromium 149.0.7827.55

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 879 ns / 962 ns / 1.37 µs | 0.38× |
| decode: tick | Zod (the TS app's schemas) | 1.55 µs / 1.82 µs / 2.08 µs | 0.67× |
| decode: tick | Zod (same checks as SeamScript) | 2.31 µs / 2.46 µs / 2.68 µs |  |
| decode: order event | SeamScript decode | 2.39 µs / 2.75 µs / 8.07 µs | 0.36× |
| decode: order event | Zod (the TS app's schemas) | 4.75 µs / 5.99 µs / 11.7 µs | 0.71× |
| decode: order event | Zod (same checks as SeamScript) | 6.65 µs / 7.37 µs / 9.45 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 2.00 ms / 2.38 ms / 4.65 ms | 0.35× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 3.80 ms / 4.77 ms / 5.12 ms | 0.67× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 5.70 ms / 7.19 ms / 13.1 ms |  |
| parse + decode: tick | SeamScript | 1.34 µs / 1.76 µs / 4.33 µs | 3.24× |
| parse + decode: tick | JSON.parse only | 415 ns / 465 ns / 559 ns |  |
| parse + decode: tick | Zod (the TS app's schemas) | 2.32 µs / 2.56 µs / 2.66 µs | 5.61× |

### webkit 26.5

| Input | Method | p50 / p95 / p99 | Ratio |
|---|---|---|---|
| decode: tick | SeamScript decode | 533 ns / 643 ns / 713 ns | 0.24× |
| decode: tick | Zod (the TS app's schemas) | 1.45 µs / 1.73 µs / 2.39 µs | 0.65× |
| decode: tick | Zod (same checks as SeamScript) | 2.24 µs / 2.54 µs / 2.67 µs |  |
| decode: order event | SeamScript decode | 1.71 µs / 2.46 µs / 2.81 µs | 0.27× |
| decode: order event | Zod (the TS app's schemas) | 4.42 µs / 5.33 µs / 5.43 µs | 0.69× |
| decode: order event | Zod (same checks as SeamScript) | 6.44 µs / 8.48 µs / 10.1 µs |  |
| decode: snapshot (40 + 1000 orders) | SeamScript decode | 1.35 ms / 1.63 ms / 1.78 ms | 0.21× |
| decode: snapshot (40 + 1000 orders) | Zod (the TS app's schemas) | 3.79 ms / 4.38 ms / 5.78 ms | 0.59× |
| decode: snapshot (40 + 1000 orders) | Zod (same checks as SeamScript) | 6.45 ms / 7.60 ms / 8.43 ms |  |
| parse + decode: tick | SeamScript | 906 ns / 1.18 µs / 1.29 µs | 3.23× |
| parse + decode: tick | JSON.parse only | 281 ns / 335 ns / 377 ns |  |
| parse + decode: tick | Zod (the TS app's schemas) | 1.88 µs / 2.33 µs / 2.67 µs | 6.68× |

## Text operations (per call, p50 / p95 / p99)

"1024 strings" cycles through 1024 different strings so that Text's grapheme-boundary cache (256 entries) never hits. The baselines are the browser's (or Node's) own `Intl.Segmenter` and `String.prototype.normalize`.

### Node v24.18.0 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 122 ns / 154 ns / 173 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 135 ns / 145 ns / 157 ns |
| length: ASCII 21 | Intl.Segmenter count | 5.92 µs / 36.8 µs / 42.5 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 161 ns / 223 ns / 2.64 µs |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 4.08 µs / 20.0 µs / 29.1 µs |
| NFC: ASCII 21 | Text.nfc | 120 ns / 151 ns / 198 ns |
| NFC: ASCII 21 | String.prototype.normalize | 111 ns / 182 ns / 215 ns |
| length: Japanese 20 | Text.length (same string: cached) | 133 ns / 148 ns / 155 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 149 ns / 165 ns / 169 ns |
| length: Japanese 20 | Intl.Segmenter count | 6.45 µs / 19.9 µs / 35.7 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 166 ns / 229 ns / 1.16 µs |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 4.47 µs / 25.5 µs / 36.2 µs |
| NFC: Japanese 20 | Text.nfc | 124 ns / 147 ns / 183 ns |
| NFC: Japanese 20 | String.prototype.normalize | 141 ns / 170 ns / 182 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 51 ns / 78 ns / 84 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 1.14 µs / 1.24 µs / 1.39 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 8.05 µs / 34.3 µs / 36.9 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 1.46 µs / 1.93 µs / 10.6 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 5.46 µs / 22.1 µs / 35.1 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 557 ns / 1.01 µs / 1.15 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 298 ns / 348 ns / 355 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 41 ns / 62 ns / 72 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 1.13 µs / 1.28 µs / 1.53 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 9.37 µs / 32.7 µs / 68.1 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 1.41 µs / 1.67 µs / 3.84 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 5.27 µs / 34.9 µs / 39.5 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 1.39 µs / 1.69 µs / 1.81 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 457 ns / 962 ns / 979 ns |
| length: Accented Latin | Text.length (same string: cached) | 155 ns / 178 ns / 193 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 167 ns / 210 ns / 223 ns |
| length: Accented Latin | Intl.Segmenter count | 7.24 µs / 30.1 µs / 44.7 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 150 ns / 183 ns / 632 ns |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 4.26 µs / 17.3 µs / 33.1 µs |
| NFC: Accented Latin | Text.nfc | 2.58 µs / 3.08 µs / 19.7 µs |
| NFC: Accented Latin | String.prototype.normalize | 807 ns / 1.06 µs / 2.92 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 28 ns / 30 ns / 31 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 17.3 µs / 24.8 µs / 28.7 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 581 µs / 1.20 ms / 3.14 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 176 ns / 196 ns / 333 ns |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 7.82 µs / 19.5 µs / 59.1 µs |
| NFC: Japanese 10 KB | Text.nfc | 17.3 µs / 21.5 µs / 39.0 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 7.55 µs / 8.44 µs / 8.78 µs |

### Node v24.18.0 (Text: host ICU)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 57 ns / 72 ns / 78 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 62 ns / 84 ns / 100 ns |
| length: ASCII 21 | Intl.Segmenter count | 5.36 µs / 32.4 µs / 49.1 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 96 ns / 264 ns / 572 ns |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 4.06 µs / 27.0 µs / 33.2 µs |
| NFC: ASCII 21 | Text.nfc | 102 ns / 241 ns / 327 ns |
| NFC: ASCII 21 | String.prototype.normalize | 81 ns / 129 ns / 143 ns |
| length: Japanese 20 | Text.length (same string: cached) | 5.35 µs / 26.1 µs / 40.5 µs |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 5.98 µs / 21.6 µs / 24.5 µs |
| length: Japanese 20 | Intl.Segmenter count | 6.18 µs / 22.9 µs / 27.2 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 4.13 µs / 22.6 µs / 29.6 µs |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 4.24 µs / 19.6 µs / 23.2 µs |
| NFC: Japanese 20 | Text.nfc | 145 ns / 190 ns / 208 ns |
| NFC: Japanese 20 | String.prototype.normalize | 99 ns / 129 ns / 156 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 7.34 µs / 21.7 µs / 23.0 µs |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 7.06 µs / 22.9 µs / 30.6 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 7.00 µs / 21.6 µs / 24.6 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 5.54 µs / 24.0 µs / 27.0 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 5.43 µs / 21.3 µs / 25.9 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 316 ns / 389 ns / 482 ns |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 226 ns / 338 ns / 357 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 8.43 µs / 27.1 µs / 29.2 µs |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 7.72 µs / 31.1 µs / 35.8 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 7.82 µs / 23.4 µs / 33.6 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 4.84 µs / 18.8 µs / 22.7 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 4.65 µs / 22.5 µs / 27.9 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 428 ns / 510 ns / 538 ns |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 334 ns / 453 ns / 527 ns |
| length: Accented Latin | Text.length (same string: cached) | 5.96 µs / 19.2 µs / 20.0 µs |
| length: Accented Latin | Text.length (1024 strings: uncached) | 6.30 µs / 23.4 µs / 31.1 µs |
| length: Accented Latin | Intl.Segmenter count | 6.23 µs / 23.7 µs / 31.1 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 3.60 µs / 23.4 µs / 32.6 µs |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 3.96 µs / 20.5 µs / 26.0 µs |
| NFC: Accented Latin | Text.nfc | 665 ns / 1.10 µs / 2.40 µs |
| NFC: Accented Latin | String.prototype.normalize | 592 ns / 933 ns / 2.43 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 478 µs / 1.40 ms / 2.17 ms |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 486 µs / 993 µs / 1.74 ms |
| length: Japanese 10 KB | Intl.Segmenter count | 479 µs / 690 µs / 1.51 ms |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 6.90 µs / 33.7 µs / 45.8 µs |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 5.99 µs / 12.8 µs / 75.9 µs |
| NFC: Japanese 10 KB | Text.nfc | 8.40 µs / 13.8 µs / 14.5 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 5.98 µs / 8.69 µs / 9.52 µs |

### chromium 149.0.7827.55 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 69 ns / 74 ns / 83 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 78 ns / 84 ns / 93 ns |
| length: ASCII 21 | Intl.Segmenter count | 5.97 µs / 14.9 µs / 23.3 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 112 ns / 122 ns / 132 ns |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 4.73 µs / 15.3 µs / 19.2 µs |
| NFC: ASCII 21 | Text.nfc | 85 ns / 93 ns / 97 ns |
| NFC: ASCII 21 | String.prototype.normalize | 104 ns / 113 ns / 115 ns |
| length: Japanese 20 | Text.length (same string: cached) | 68 ns / 73 ns / 76 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 75 ns / 86 ns / 90 ns |
| length: Japanese 20 | Intl.Segmenter count | 6.39 µs / 17.3 µs / 26.6 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 113 ns / 129 ns / 135 ns |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 4.93 µs / 14.9 µs / 22.9 µs |
| NFC: Japanese 20 | Text.nfc | 82 ns / 88 ns / 94 ns |
| NFC: Japanese 20 | String.prototype.normalize | 113 ns / 135 ns / 145 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 39 ns / 43 ns / 45 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 730 ns / 925 ns / 970 ns |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 7.86 µs / 18.6 µs / 26.9 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 937 ns / 1.11 µs / 1.47 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 6.12 µs / 18.4 µs / 28.5 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 352 ns / 378 ns / 412 ns |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 282 ns / 297 ns / 303 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 33 ns / 36 ns / 38 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 773 ns / 810 ns / 827 ns |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 6.03 µs / 20.7 µs / 26.3 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 906 ns / 1.00 µs / 1.38 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 5.91 µs / 17.0 µs / 27.1 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 990 ns / 1.06 µs / 1.10 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 340 ns / 357 ns / 366 ns |
| length: Accented Latin | Text.length (same string: cached) | 99 ns / 105 ns / 122 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 105 ns / 113 ns / 118 ns |
| length: Accented Latin | Intl.Segmenter count | 6.89 µs / 17.1 µs / 27.4 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 112 ns / 124 ns / 146 ns |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 5.26 µs / 18.8 µs / 26.7 µs |
| NFC: Accented Latin | Text.nfc | 2.04 µs / 2.31 µs / 2.71 µs |
| NFC: Accented Latin | String.prototype.normalize | 724 ns / 813 ns / 902 ns |
| length: Japanese 10 KB | Text.length (same string: cached) | 24 ns / 26 ns / 26 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 9.38 µs / 10.5 µs / 10.8 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 465 µs / 554 µs / 659 µs |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 122 ns / 155 ns / 305 ns |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 15.2 µs / 17.8 µs / 23.0 µs |
| NFC: Japanese 10 KB | Text.nfc | 8.22 µs / 9.04 µs / 9.56 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 6.42 µs / 6.93 µs / 7.26 µs |

### webkit 26.5 (Text: WASM core, Unicode 17.0.0)

| Operation / string | Method | p50 / p95 / p99 |
|---|---|---|
| length: ASCII 21 | Text.length (same string: cached) | 55 ns / 60 ns / 62 ns |
| length: ASCII 21 | Text.length (1024 strings: uncached) | 62 ns / 66 ns / 74 ns |
| length: ASCII 21 | Intl.Segmenter count | 4.91 µs / 6.31 µs / 7.12 µs |
| slice(0, 10): ASCII 21 | Text.slice (uncached) | 270 ns / 300 ns / 317 ns |
| slice(0, 10): ASCII 21 | Intl.Segmenter slice | 3.74 µs / 4.61 µs / 5.05 µs |
| NFC: ASCII 21 | Text.nfc | 85 ns / 105 ns / 167 ns |
| NFC: ASCII 21 | String.prototype.normalize | 26 ns / 33 ns / 36 ns |
| length: Japanese 20 | Text.length (same string: cached) | 73 ns / 83 ns / 103 ns |
| length: Japanese 20 | Text.length (1024 strings: uncached) | 82 ns / 94 ns / 101 ns |
| length: Japanese 20 | Intl.Segmenter count | 5.28 µs / 6.35 µs / 6.94 µs |
| slice(0, 10): Japanese 20 | Text.slice (uncached) | 280 ns / 366 ns / 408 ns |
| slice(0, 10): Japanese 20 | Intl.Segmenter slice | 4.31 µs / 5.09 µs / 5.71 µs |
| NFC: Japanese 20 | Text.nfc | 94 ns / 113 ns / 120 ns |
| NFC: Japanese 20 | String.prototype.normalize | 98 ns / 112 ns / 169 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (same string: cached) | 33 ns / 41 ns / 43 ns |
| length: Emoji (ZWJ, flags, skin tones) | Text.length (1024 strings: uncached) | 893 ns / 1.09 µs / 1.30 µs |
| length: Emoji (ZWJ, flags, skin tones) | Intl.Segmenter count | 5.61 µs / 6.89 µs / 7.67 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Text.slice (uncached) | 1.28 µs / 1.51 µs / 1.71 µs |
| slice(0, 10): Emoji (ZWJ, flags, skin tones) | Intl.Segmenter slice | 4.29 µs / 5.32 µs / 8.62 µs |
| NFC: Emoji (ZWJ, flags, skin tones) | Text.nfc | 349 ns / 386 ns / 468 ns |
| NFC: Emoji (ZWJ, flags, skin tones) | String.prototype.normalize | 192 ns / 216 ns / 310 ns |
| length: Khmer (changed in Unicode 17) | Text.length (same string: cached) | 28 ns / 31 ns / 34 ns |
| length: Khmer (changed in Unicode 17) | Text.length (1024 strings: uncached) | 901 ns / 1.06 µs / 1.48 µs |
| length: Khmer (changed in Unicode 17) | Intl.Segmenter count | 5.96 µs / 7.37 µs / 8.02 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Text.slice (uncached) | 1.27 µs / 1.55 µs / 1.66 µs |
| slice(0, 10): Khmer (changed in Unicode 17) | Intl.Segmenter slice | 4.19 µs / 5.18 µs / 5.66 µs |
| NFC: Khmer (changed in Unicode 17) | Text.nfc | 1.20 µs / 1.32 µs / 1.51 µs |
| NFC: Khmer (changed in Unicode 17) | String.prototype.normalize | 233 ns / 291 ns / 372 ns |
| length: Accented Latin | Text.length (same string: cached) | 68 ns / 85 ns / 119 ns |
| length: Accented Latin | Text.length (1024 strings: uncached) | 71 ns / 80 ns / 85 ns |
| length: Accented Latin | Intl.Segmenter count | 5.28 µs / 7.16 µs / 7.79 µs |
| slice(0, 10): Accented Latin | Text.slice (uncached) | 267 ns / 337 ns / 667 ns |
| slice(0, 10): Accented Latin | Intl.Segmenter slice | 3.74 µs / 4.72 µs / 5.18 µs |
| NFC: Accented Latin | Text.nfc | 2.27 µs / 2.48 µs / 2.51 µs |
| NFC: Accented Latin | String.prototype.normalize | 1.01 µs / 1.15 µs / 1.29 µs |
| length: Japanese 10 KB | Text.length (same string: cached) | 17 ns / 20 ns / 26 ns |
| length: Japanese 10 KB | Text.length (1024 strings: uncached) | 10.4 µs / 11.9 µs / 13.4 µs |
| length: Japanese 10 KB | Intl.Segmenter count | 261 µs / 323 µs / 407 µs |
| slice(0, 10): Japanese 10 KB | Text.slice (uncached) | 273 ns / 334 ns / 427 ns |
| slice(0, 10): Japanese 10 KB | Intl.Segmenter slice | 7.58 µs / 10.8 µs / 13.9 µs |
| NFC: Japanese 10 KB | Text.nfc | 11.4 µs / 14.3 µs / 21.2 µs |
| NFC: Japanese 10 KB | String.prototype.normalize | 5.19 µs / 6.26 µs / 6.68 µs |

## Start-up time added by loading the WASM core

The same app is built with and without the core, and the two builds are loaded alternately in fresh contexts. Values run from navigation start to the start of the main module (`seam:main`). With the core, main runs only after the core's top-level await (base64 decoding, compilation, instantiation) settles.

| Browser | Without core p50 / p95 / p99 | With core p50 / p95 / p99 | Difference (p50) | WebAssembly.instantiate p50 / p95 / p99 |
|---|---|---|---|---|
| chromium 149.0.7827.55 | 81.6 ms / 86.9 ms / 92.7 ms | 84.5 ms / 87.3 ms / 94.3 ms | 2.90 ms | 0.88 ms / 1.27 ms / 1.32 ms |
| webkit 26.5 | 37.9 ms / 43.2 ms / 47.0 ms | 46.3 ms / 54.0 ms / 58.3 ms | 8.42 ms | 2.08 ms / 2.68 ms / 4.02 ms |

Node (import in a fresh process): `@seamscript/core` 35.7 ms / 38.7 ms / 38.7 ms; `@seamscript/runtime` alone 6.63 ms / 7.91 ms / 8.22 ms (20 runs each).

## Latency from server send to DOM update

For every price tick, the page records when the WebSocket received it and when that row's data-version changed (MutationObserver). Receive→DOM is measured entirely inside the page. Send→DOM is measured from the server's send time and includes the network, waiting in the page's event queue, and clock skew between processes. "Handler" is the time the app itself measures to decode and apply one message (rendering not included). Each condition is repeated with the order of the apps swapped.

- **Per frame** (the app as designed): state updates on every message, and the UI is notified once per frame. When the same instrument moves several times within one frame, the intermediate values are never shown, so "shown/received" drops below 1.
- **Per message** (`?render=each`, for benchmarking only): the app renders on every message. With no wait for rendering, differences in handling show up more clearly, but at high rates the main thread saturates.

### Per frame, 50 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 300/300 | 1.45 ms / 9.26 ms / 13.5 ms | 2.31 ms / 10.2 ms / 14.1 ms | 0.10 ms / 0.23 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 300/300 | 1.37 ms / 11.0 ms / 13.6 ms | 2.20 ms / 11.8 ms / 15.3 ms | 0.13 ms / 0.30 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 300/300 | 1.37 ms / 10.3 ms / 14.0 ms | 2.19 ms / 11.0 ms / 17.3 ms | 0.13 ms / 0.25 ms |
| chromium 149.0.7827.55 | SeamScript | 300/300 | 1.56 ms / 8.18 ms / 11.0 ms | 2.40 ms / 9.12 ms / 12.8 ms | 0.10 ms / 0.20 ms |
| webkit 26.5 | SeamScript | 300/301 | 8.96 ms / 19.5 ms / 27.8 ms | 10.1 ms / 21.7 ms / 32.3 ms | 0.08 ms / 0.24 ms |
| webkit 26.5 | TypeScript + Zod | 299/300 | 9.36 ms / 20.9 ms / 25.6 ms | 10.1 ms / 22.0 ms / 33.5 ms | 0.12 ms / 0.34 ms |
| webkit 26.5 | TypeScript + Zod | 299/301 | 8.82 ms / 21.2 ms / 31.6 ms | 9.67 ms / 24.9 ms / 36.1 ms | 0.12 ms / 0.36 ms |
| webkit 26.5 | SeamScript | 300/301 | 7.96 ms / 16.6 ms / 26.9 ms | 8.92 ms / 20.3 ms / 36.3 ms | 0.08 ms / 0.38 ms |

### Per frame, 500 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 2751/3004 | 8.39 ms / 13.6 ms / 14.4 ms | 9.76 ms / 17.5 ms / 18.5 ms | 0.03 ms / 0.11 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 2755/3001 | 8.43 ms / 13.5 ms / 14.4 ms | 9.30 ms / 17.2 ms / 18.2 ms | 0.04 ms / 0.10 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 2758/3002 | 8.61 ms / 13.6 ms / 14.4 ms | 9.52 ms / 17.4 ms / 18.3 ms | 0.04 ms / 0.12 ms |
| chromium 149.0.7827.55 | SeamScript | 2734/3000 | 8.45 ms / 13.6 ms / 14.2 ms | 9.71 ms / 17.7 ms / 19.3 ms | 0.03 ms / 0.12 ms |
| webkit 26.5 | SeamScript | 2711/3003 | 8.18 ms / 16.4 ms / 25.1 ms | 9.19 ms / 21.0 ms / 32.2 ms | 0.02 ms / 0.12 ms |
| webkit 26.5 | TypeScript + Zod | 2681/2995 | 9.26 ms / 18.1 ms / 26.8 ms | 10.5 ms / 23.4 ms / 34.5 ms | 0.02 ms / 0.16 ms |
| webkit 26.5 | TypeScript + Zod | 2661/3006 | 9.84 ms / 21.1 ms / 28.8 ms | 11.1 ms / 26.5 ms / 40.1 ms | 0.02 ms / 0.18 ms |
| webkit 26.5 | SeamScript | 2678/3002 | 9.84 ms / 20.4 ms / 27.3 ms | 10.8 ms / 25.9 ms / 37.3 ms | 0.02 ms / 0.14 ms |

### Per frame, 2000 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 8019/11999 | 6.18 ms / 13.0 ms / 16.5 ms | 11.6 ms / 25.4 ms / 32.8 ms | 0.03 ms / 0.12 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 7925/12020 | 6.46 ms / 13.0 ms / 15.7 ms | 11.1 ms / 28.3 ms / 38.4 ms | 0.03 ms / 0.13 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 8072/12039 | 6.04 ms / 12.9 ms / 15.5 ms | 12.0 ms / 27.2 ms / 35.6 ms | 0.03 ms / 0.10 ms |
| chromium 149.0.7827.55 | SeamScript | 7937/11998 | 6.04 ms / 14.0 ms / 16.9 ms | 12.6 ms / 29.2 ms / 40.8 ms | 0.03 ms / 0.10 ms |
| webkit 26.5 | SeamScript | 6782/11997 | 10.3 ms / 18.3 ms / 24.2 ms | 11.3 ms / 26.1 ms / 33.8 ms | 0.02 ms / 0.08 ms |
| webkit 26.5 | TypeScript + Zod | 6355/12042 | 10.3 ms / 20.1 ms / 27.3 ms | 11.7 ms / 28.2 ms / 34.9 ms | 0.02 ms / 0.10 ms |
| webkit 26.5 | TypeScript + Zod | 6866/12033 | 9.20 ms / 18.1 ms / 24.0 ms | 10.3 ms / 24.9 ms / 33.1 ms | 0.02 ms / 0.10 ms |
| webkit 26.5 | SeamScript | 6597/12026 | 10.1 ms / 19.0 ms / 25.5 ms | 11.3 ms / 26.4 ms / 33.2 ms | 0.02 ms / 0.08 ms |

### Per message, 50 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 300/300 | 0.85 ms / 1.40 ms / 1.69 ms | 1.59 ms / 2.81 ms / 3.74 ms | 0.09 ms / 0.26 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 300/300 | 0.53 ms / 0.94 ms / 1.34 ms | 1.00 ms / 1.67 ms / 3.13 ms | 0.08 ms / 0.36 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 301/301 | 0.55 ms / 1.13 ms / 1.30 ms | 1.03 ms / 2.22 ms / 3.97 ms | 0.09 ms / 0.28 ms |
| chromium 149.0.7827.55 | SeamScript | 301/301 | 0.96 ms / 1.30 ms / 1.62 ms | 1.79 ms / 2.46 ms / 5.89 ms | 0.10 ms / 0.22 ms |
| webkit 26.5 | SeamScript | 300/300 | 0.78 ms / 1.44 ms / 4.76 ms | 1.68 ms / 5.71 ms / 19.8 ms | 0.08 ms / 0.34 ms |
| webkit 26.5 | TypeScript + Zod | 300/300 | 0.74 ms / 1.30 ms / 1.94 ms | 1.55 ms / 4.21 ms / 9.51 ms | 0.14 ms / 0.60 ms |
| webkit 26.5 | TypeScript + Zod | 300/300 | 0.80 ms / 1.48 ms / 2.64 ms | 1.74 ms / 4.70 ms / 8.91 ms | 0.14 ms / 0.88 ms |
| webkit 26.5 | SeamScript | 300/300 | 0.80 ms / 1.42 ms / 2.26 ms | 1.74 ms / 4.27 ms / 7.78 ms | 0.08 ms / 0.28 ms |

### Per message, 500 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 3000/3000 | 0.27 ms / 0.52 ms / 0.76 ms | 0.97 ms / 4.47 ms / 6.65 ms | 0.03 ms / 0.06 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 3001/3001 | 0.25 ms / 0.44 ms / 0.55 ms | 0.91 ms / 3.80 ms / 5.18 ms | 0.03 ms / 0.08 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 3000/3000 | 0.26 ms / 0.46 ms / 0.56 ms | 0.96 ms / 4.10 ms / 5.44 ms | 0.03 ms / 0.08 ms |
| chromium 149.0.7827.55 | SeamScript | 3000/3000 | 0.28 ms / 0.49 ms / 0.58 ms | 0.98 ms / 4.18 ms / 5.58 ms | 0.03 ms / 0.07 ms |
| webkit 26.5 | SeamScript | 3000/3000 | 0.32 ms / 0.74 ms / 1.14 ms | 2.32 ms / 8.49 ms / 13.5 ms | 0.02 ms / 0.14 ms |
| webkit 26.5 | TypeScript + Zod | 3002/3002 | 0.30 ms / 0.72 ms / 1.06 ms | 2.26 ms / 8.78 ms / 12.8 ms | 0.04 ms / 0.16 ms |
| webkit 26.5 | TypeScript + Zod | 3004/3004 | 0.28 ms / 0.70 ms / 1.22 ms | 2.19 ms / 8.59 ms / 12.4 ms | 0.04 ms / 0.20 ms |
| webkit 26.5 | SeamScript | 3005/3005 | 0.32 ms / 0.76 ms / 1.38 ms | 2.32 ms / 8.73 ms / 12.8 ms | 0.02 ms / 0.14 ms |

### Per message, 1000 messages/s

| Browser | App | Shown/received | Receive→DOM p50 / p95 / p99 | Send→DOM p50 / p95 / p99 | Handler p50 / p99 |
|---|---|---|---|---|---|
| chromium 149.0.7827.55 | SeamScript | 6003/6003 | 0.19 ms / 0.40 ms / 0.63 ms | 1.09 ms / 4.83 ms / 9.27 ms | 0.02 ms / 0.07 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 6002/6002 | 0.19 ms / 0.52 ms / 0.75 ms | 1.24 ms / 9.07 ms / 13.5 ms | 0.02 ms / 0.09 ms |
| chromium 149.0.7827.55 | TypeScript + Zod | 6006/6006 | 0.19 ms / 0.57 ms / 0.74 ms | 1.30 ms / 8.72 ms / 11.8 ms | 0.02 ms / 0.08 ms |
| chromium 149.0.7827.55 | SeamScript | 6007/6007 | 0.20 ms / 0.56 ms / 0.73 ms | 1.31 ms / 8.02 ms / 10.9 ms | 0.02 ms / 0.07 ms |
| webkit 26.5 | SeamScript | 6003/6003 | 0.26 ms / 0.58 ms / 0.84 ms | 3.13 ms / 11.1 ms / 16.4 ms | 0.02 ms / 0.10 ms |
| webkit 26.5 | TypeScript + Zod | 6015/6015 | 0.22 ms / 0.56 ms / 0.82 ms | 3.21 ms / 11.1 ms / 14.9 ms | 0.02 ms / 0.14 ms |
| webkit 26.5 | TypeScript + Zod | 6008/6008 | 0.24 ms / 0.58 ms / 0.90 ms | 3.50 ms / 11.7 ms / 18.8 ms | 0.02 ms / 0.14 ms |
| webkit 26.5 | SeamScript | 5991/5991 | 0.26 ms / 0.60 ms / 0.88 ms | 3.72 ms / 12.5 ms / 17.2 ms | 0.02 ms / 0.10 ms |

## `seamc check` and `tsc` times (hyperfine)

To compare the same program, the baseline is `tsc --noEmit` run on the plain TS that `seamc build` emits.

| Command | Mean ± std dev | Median | Min–max | Ratio | Runs |
|---|---|---|---|---|---|
| seamc check (app) | 2.388 s ± 0.372 | 2.359 s | 1.982–2.939 s | 1.20× | 10 |
| tsc --noEmit (app, as plain TS) | 1.987 s ± 0.175 | 2.037 s | 1.554–2.170 s | 1.00× | 10 |
| tsc --noEmit (TS + Zod twin) | 2.101 s ± 0.166 | 2.092 s | 1.910–2.481 s | 1.06× | 10 |

## Bundle size (the JS and CSS that index.html loads)

| Build | Raw | gzip | brotli | Difference from TS + Zod (gzip) |
|---|---|---|---|---|
| SeamScript (WASM core) | 499.3 KB | 171.5 KB | 152.3 KB | +73.2 KB |
| SeamScript (no core) | 258.8 KB | 81.1 KB | 70.3 KB | -17.3 KB |
| TypeScript + Zod | 327.4 KB | 98.4 KB | 85.4 KB | +0.0 KB |
