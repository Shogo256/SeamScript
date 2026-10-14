# @seamscript/core

A WebAssembly core that performs `Text` normalization (NFC / NFD) and grapheme segmentation (extended grapheme clusters), pinned to Unicode 17.0.0. The browsers' own ICU versions vary (as of October 2026, Chromium 149 and Firefox 151 implement Unicode 17, while WebKit 26.5 and Node 24 implement 16), so the character count of the same memo can differ between the browser and the server. With the core, every environment gives the same answer.

## Usage

In production builds, the compiler (`seamc build --production`, and the Vite and unplugin plugins) adds `import "@seamscript/core"` to each module. This import loads the WASM with a top-level await and plugs it into `@seamscript/runtime`. To load it yourself, import it once at your app's entry point.

```ts
import "@seamscript/core";
```

- **Loading never rejects, even when it fails.** Instead, `Text.status` becomes `"failed"` and Text operations throw `CoreUnavailableError`. Evaluation of your app doesn't stop, so check `Text.status` at startup and tell the user on screen.
- **Your CSP needs `'wasm-unsafe-eval'`** (`script-src 'self' 'wasm-unsafe-eval'`).
- The WASM is embedded in the JS as base64, so no bundler configuration is needed. It adds about 111KB gzipped.
- `@seamscript/runtime` is a peerDependency, so that the core plugs into the same instance the app uses.

## Speed

Most text never goes through WASM. A table records which characters are "unchanged by NFC / NFD" and which are "always a grapheme on their own" (the table is generated at build time from the Rust crates, so its Unicode version is the same as the WASM's). For a string made entirely of such characters, JS alone gives the answer. Strings are passed to WASM as UTF-16, and normalization passes unchanged input straight through using the quick check from UAX #15. `Text.slice(t, 0, n)`, which only needs the start of a long string, processes only a prefix of it.

For 20 Japanese characters, `Text.length` takes 1–3% of the time of counting with `Intl.Segmenter`, and `Text.nfc` takes 0.6–0.9 times as long as the native `normalize`. For strings that go through WASM, such as strings with combining characters or Khmer, `Text.nfc` takes 2.3–4.7 times as long as native, and `Text.length` 0.4–0.8 times as long as Intl (the full benchmark tables are in `sandbox/RESULTS.md`).

## Rust crate

`seamscript-core` can also be used from native Rust. If the backend uses the same version of the crate, its definition of "one character" matches the client's.

```rust
use seamscript_core::{grapheme_count, normalize, Form};

let memo = normalize(input, Form::Nfc);
if grapheme_count(&memo) > 32 { /* too long */ }
```

`unicode-normalization` and `unicode-segmentation` are pinned to exact versions, and a compile-time check confirms that both use the same Unicode version.
