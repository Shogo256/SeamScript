# @seamscript/core

A WebAssembly core that performs `Text` normalization (NFC / NFD) and grapheme segmentation (extended grapheme clusters), pinned to Unicode 17.0.0. The browsers' own ICU versions vary (as of October 2026, Chromium 149, Firefox 151 and the official Node 24 builds implement Unicode 17, while WebKit 26.5 and Node builds linked against an older system ICU implement 16), so the character count of the same memo can differ between the browser and the server. With the core, every environment gives the same answer.

## Usage

In production builds, the compiler (`seamc build --production`, and the Vite and unplugin plugins) adds `import "@seamscript/core"` to each module. This import loads the WASM with a top-level await and plugs it into `@seamscript/runtime`. To load it yourself, import it once at your app's entry point.

```ts
import "@seamscript/core";
```

- **Loading never rejects, even when it fails.** Instead, `Text.status` becomes `"failed"` and Text operations throw `CoreUnavailableError`. Evaluation of your app doesn't stop, so check `Text.status` at startup and tell the user on screen.
- **Your CSP needs `'wasm-unsafe-eval'`** (`script-src 'self' 'wasm-unsafe-eval'`).
- The WASM is embedded in the JS as base64, so no bundler configuration is needed. It adds about 90KB gzipped.
- `@seamscript/runtime` is a peerDependency, so that the core plugs into the same instance the app uses.

## Speed

Most text never goes through WASM. A table records which characters are "unchanged by NFC / NFD" and which are "always a grapheme on their own" (the table is generated at build time from the Rust crates, so its Unicode version is the same as the WASM's). For a string made entirely of such characters, JS alone gives the answer. Strings are passed to WASM as UTF-16. There, grapheme segmentation is the crate's own table-driven implementation of UAX #29 (two array reads per character), and normalization passes unchanged input straight through using the quick check from UAX #15. `Text.slice(t, 0, n)`, which only needs the start of a long string, processes only a prefix of it.

For 20 Japanese characters, `Text.length` takes 1–2% of the time of counting with `Intl.Segmenter`, and `Text.nfc` takes 0.7–1.0 times as long as the native `normalize`. For strings that go through WASM, such as emoji sequences or Khmer, `Text.length` takes 0.09–0.16 times as long as Intl (0.15–0.22 times against a Node whose ICU implements Unicode 17), and `Text.nfc` on strings that normalization can change takes 2.3–5.1 times as long as native (the full benchmark tables are in `sandbox/RESULTS.md`).

## Rust crate

`seamscript-core` can also be used from native Rust. If the backend uses the same version of the crate, its definition of "one character" matches the client's.

```rust
use seamscript_core::{grapheme_count, normalize, Form};

let memo = normalize(input, Form::Nfc);
if grapheme_count(&memo) > 32 { /* too long */ }
```

Normalization comes from `unicode-normalization`, pinned to an exact version. Grapheme segmentation is the crate's own (`src/segment.rs`), on a table that `cargo run --example gcb_table` generates from Unicode 17.0.0's data files. A compile-time check confirms that both use the same Unicode version, and the tests compare the segmentation with `unicode-segmentation` next to every code point and on random strings.
