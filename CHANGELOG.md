# Changelog

All `@seamscript/*` packages and `create-seamscript` are released together, with one version number. Releases are on GitHub: https://github.com/Shogo256/SeamScript/releases

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
