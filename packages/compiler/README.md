# @seamscript/compiler

The SeamScript compiler. It converts `.seam.ts` / `.seam.tsx` into plain TypeScript and adds the SeamScript checks on top of TypeScript's type checking.

## seamc

```bash
seamc check [-p tsconfig.json] [-w] [files...]
seamc build [-p tsconfig.json] --outDir <dir> [--production [--defer-core]] [-w]
seamc transform <file.seam.ts>
seamc --help | --version
```

- `check`: type-checks the project. Use it instead of `tsc --noEmit`. Exits with code 1 if there are errors.
- `build`: if checking passes, writes each `.seam.ts` to `--outDir` as plain TypeScript. File names don't change, so `import "./order.seam"` still resolves. With `--production`, each file that uses Text (a `Text` field or decode target, or a value-position `Text`) imports `@seamscript/core` (the WASM core); `--defer-core` imports `@seamscript/core/deferred` instead, which loads the core without holding up start-up (await `Text.ready`). `build` writes only `.seam.ts` files, so a plain `.ts` file that uses Text needs `import "@seamscript/core"` itself (or once in the entry point).
- `transform`: prints the output for one file.
- `-w` / `--watch`: checks again whenever a file or tsconfig.json changes. Files whose text hasn't changed are not parsed or transformed again.
- `--help` (also `seamc` on its own) and `--version`: in a terminal they start with the SeamScript logo; piped or in CI they print plain text only.

Checking runs in two passes. The first pass finds the sources of outside data (identified by their declarations in TypeScript's lib, so a local function named `parse` is never one), and the second pass type-checks them as `Unknown`. It takes about 1.3 to 1.5 times as long as tsc on the same program.

## Sources of outside data

| Built in | |
|---|---|
| Fetch | `Body.json()`, `Body.text()`, `Body.arrayBuffer()`, `Body.bytes()` (`Response`, `Request`) |
| JSON | `JSON.parse` |
| Storage | `Storage.getItem` (`localStorage`, `sessionStorage`), `StorageEvent.newValue` / `oldValue`, `IDBRequest.result`, `IDBCursorWithValue.value` |
| URL and page state | `URLSearchParams.get` / `getAll`, `Location.hash`, `History.state`, `Document.cookie` |
| Messages | `MessageEvent.data` (WebSocket, workers, `postMessage`), `ExtendableMessageEvent.data`, `PushMessageData.json()` / `text()` |
| Clipboard and files | `Clipboard.readText()`, `DataTransfer.getData`, `Blob.text()`, `Blob.arrayBuffer()`, `Blob.bytes()` (files, MediaRecorder chunks), `FileReader.result` |
| Audio | `MediaStreamTrack.getSettings()` (a device may not deliver what was asked for), and the first parameter of `process` in a class that extends `AudioWorkletProcessor`: each of its elements (`inputs[0]`) is `Unknown`, to be decoded as `Planar<Float32, Channels>` |

`location.search` is not a source: read it through `URLSearchParams`. Writes (`location.hash = "#a"`) are not affected. TypeScript's lib has no AudioWorklet scope, so `AudioWorkletProcessor` is whatever the project declares under that name; destructuring `process`'s inputs is SEAM2004.

A project declares more in `tsconfig.json`:

```jsonc
{
  "seamscript": {
    // "Owner.member": a method or property of an interface, class, namespace or
    // object type (declared in the project or a package); "name": a function or variable.
    "sources": ["NativeBridge.receive", "AppStore.load", "readConfig"],
    // "unknown" (default): a value whose declared type is `any` in a package's type
    // declarations is SEAM2005 until decoded. "allow": let it through.
    "externalAny": "unknown"
  }
}
```

A declared method that returns a promise gives `Promise<Unknown>`. `seamc`, the editor plugin and the quick fixes all read these settings, and `seamc` reports a misspelled or invalid setting as a configuration error.

## Diagnostics

| Code | Meaning |
|---|---|
| SEAM1000 | Syntax error |
| SEAM1101 | A type that can't cross a boundary (in a field or as a decode target: functions, any, generic types, and so on) |
| SEAM1102 | A boundary can only appear at the top level of a module |
| SEAM1103 | A boundary can contain only fields |
| SEAM1104 | A union boundary that lists boundaries can list only boundaries (`boundary Event = Paid \| Int64`). A boundary of a field type alone, `boundary Chunk = Pcm<Int16, 16000, 1>`, is not a union boundary |
| SEAM1105 | A union member has no discriminant field |
| SEAM1106 | A type that isn't a boundary is referenced as a boundary |
| SEAM1107 | A constraint the field's type can't take (`maxLength` on `string`, `in` on Text), one no value or no consistent test satisfies (`in 10..1`, a `g` flag), or constraints on a union of boundaries |
| SEAM1201 | Reserved (an invalid decode target is reported as SEAM1101) |
| SEAM1301 | A Text other than `Text<NFC>` / `Text<NFD>` |
| SEAM1302 | `Pcm` / `Planar` with arguments they don't take (`Pcm<Int24, 16000, 1>`, a rate that isn't a positive whole number, `Planar<Int16, 1>`) |
| SEAM1401 | A latest function can't be a generator |
| SEAM1402 | The type of a latest function's AbortSignal parameter isn't written as `AbortSignal` |
| SEAM2001 | Unknown flows to an exit other than decode (`as`, assignment to `unknown` or `any`, templates, `+`, `in`, `throw`, and so on) |
| SEAM2002 | A call that takes Unknown and returns any / unknown |
| SEAM2003 | A method that is a source of outside data is referenced without being called |
| SEAM2004 | A property that is a source of outside data is destructured |
| SEAM2005 | A package's `any` is used without a decode (with `"externalAny": "unknown"`, the default) |
| SEAM2101 | Access to a Text in UTF-16 units (`.length`, indexing, `.slice`, and so on) |
| SEAM2201 | A value containing a bigint is passed to `JSON.stringify` (pass `Order.encode(o)` instead) |

Every message says how to fix the problem. In the editor, the mechanical fixes are quick fixes: SEAM2001, SEAM2005 and TypeScript's assignment errors on a typed variable (`const o: Order = JSON.parse(s)` becomes `const o = decode Order from JSON.parse(s)`), SEAM2101 (`Text.length(t)`, `Text.at(t, i)`), SEAM2201 (`Order.encode(o)`, `orders.map(Order.encode)`) and SEAM1402 (write `AbortSignal`).

## Bundlers

```ts
// vite.config.ts
import seamscript from "@seamscript/compiler/vite";
export default { plugins: [seamscript()] };
```

```ts
// esbuild / Rollup / Rolldown / webpack / Rspack / Rsbuild / Bun
import { esbuild, rollup, rolldown, webpack, rspack, rsbuild, bun } from "@seamscript/compiler/unplugin";
```

Each plugin converts `.seam.ts` into TypeScript and then hands it to the bundler (or to the project's TypeScript loader). The plugins don't type-check, so use them together with `seamc check`.

The `core` option decides whether the modules that use Text import `@seamscript/core`: `true`, `false`, or `"deferred"` (import `@seamscript/core/deferred`, which loads the core in the background; await `Text.ready` before the first Text operation). For Vite, the default is on only for `vite build` (the dev server and Vitest run on the environment's ICU). For the other bundlers, the default is on. The plugins cover plain `.ts` and `.js` modules too: one that imports `@seamscript/runtime` and calls `Text.` gets the import, so a bundle that never uses Text carries no core.

## Node API

```ts
import { createSeamProgram, transform } from "@seamscript/compiler";

const r = transform(source, "order.seam.ts");        // { code, map, diagnostics, links, syntaxError }
const p = createSeamProgram(rootNames, compilerOptions);
p.diagnostics();                                      // SeamScript and TypeScript diagnostics (positions in the original source)
```

`createChecker(ts, { sources, externalAny })` from `@seamscript/compiler/checker` creates a checker that runs on the TypeScript you pass in (the editor plugin passes tsserver's TypeScript); `readSeamConfig(raw)` from `@seamscript/compiler/config` validates a tsconfig's `"seamscript"` settings. `createSeamProgram` takes the same settings as `{ checker: { ... } }`, and `{ production, deferCore }` for the core import.
