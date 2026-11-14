# Changelog

All `@seamscript/*` packages and `create-seamscript` are released together, with one version number. Releases are on GitHub: https://github.com/Shogo256/SeamScript/releases

## 0.1.2

### Added

- **Deadlines for `latest` calls: `f.within(ms)(...args)`.** A call that has not settled `ms` milliseconds after it started aborts its `AbortSignal` and resolves to `Timeout` (`{ ok: false, error: { kind: "timeout", ms } }`), or to `Stale` if a newer call started meanwhile. It shares the line with plain calls, on a function and on a fork. Before, a deadline meant a `setTimeout` race written by hand, which neither aborted the request nor kept the latest-wins guarantee. Found by an app whose server calls an AI with a 2-second budget (CS Pro's chat widget).
- **SEAM1403: a `fetch` in a latest function that does not take the function's signal.** Such a request keeps running after the call is superseded, cancelled or out of time, so the server keeps working (and paying) for an answer nobody reads. The quick fix passes `signal`. An init object that is not a literal, or that spreads another object, is left alone.
- **`poll(read, { every, maxEvery?, onResult })`** in `@seamscript/runtime`: reads one at a time, `every` ms apart after each read ends, doubles the wait after failures up to `maxEvery`, starts no read while the page is hidden (and reads at once when it is shown if one fell due), and stops for good on `stop()`, aborting a read in flight. For state a page must notice changing on the server, such as a switch that turns a feature off.


### Fixed

- **A variable typed `Response` for `fetch`'s result was rejected without saying what to write.** `let res: Response; res = await fetch(...)` (the usual shape when the fetch sits in a `try`) is SEAM2001, rightly, as the lib's `Response` lets `json()` escape as `any`; but the type to use, `SeamResponse`, had to be imported by hand. It is now available without an import, like `fetch` itself, and SEAM2001 into `Response` says to type the variable `SeamResponse`. Found by the first app built outside this repository (a messenger screen).

### Tests

- A boundary whose branded fields are all string-based (`Zoned`, `Text`, `Decimal`) keeps their types through `decode`, for one value and for an array. `Encoded<NoInfer<T>>` fixed this; the test guards it, since an `Int64` field hides the bug.

## 0.1.1

### Fixed

- **Spreading Unknown into an object literal or JSX props let its fields out unchecked.** `{ ...JSON.parse(s) }` gave a copy whose type had only the Unknown brand's symbol key, which TypeScript accepts as `Record<string, string>` and the like, so the data reached typed code without a `decode`. It is now SEAM2001, for every source of outside data. An array spread is still allowed where the destination keeps Unknown (`Unknown[]`).
- **Node.js 22.18 or later** (24.11 or later on the 24 line) is required, as Babel 8, which the compiler's parser is a fork of, requires. 0.1.0 said Node 20; on it, `npm install` half-worked and the dev server failed with an error about native bindings. `create-seamscript` now says so and stops before creating anything, and new apps declare the range in `engines`.
- **The Vite dev server pre-bundles dependencies again.** Its dependency scan read `.seam.ts` files without compiling them, stopped at the first `boundary`, and skipped pre-bundling (`Failed to run dependency scan`).

### Added

- **`@seamscript/runtime/node`**: `env.get` / `env.all` and `file.readText` / `file.readJson` return the environment and files as an Unknown that hides its contents at run time as well. Every use but `decode` throws `UnknownAccess`, naming the operation and never the value, and `console.log` prints `[Unknown]`.
- **Node.js sources of outside data in `seamc check`**: `process.env.X` (each variable read; `process.env` used whole is Unknown whole), `fs.readFileSync`, `fs/promises` `readFile` and the data passed to `fs.readFile`'s callback, matched in `@types/node`'s own declarations. Testing or listing the whole of `process.env` (`"PORT" in process.env`, `Object.keys(process.env)`) is SEAM2001, with a message showing how to decode one variable instead.

## 0.1.0

The first release: the `boundary`, `decode`, `latest` and `Unknown` constructs and the boundary types (`Text`, `Int64`, `Decimal`, `Zoned`, `Bytes`, `Pcm`, `Planar`), the compiler (`seamc`, Vite and unplugin plugins), the WASM core, the editor plugin, `@seamscript/react` and `create-seamscript`. Projects are checked by edition 2026.
