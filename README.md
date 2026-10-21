# SeamScript

```text
   _____                     _____           _       __
  / ___/___  ____ _____ ___ / ___/__________(_)___  / /_
  \__ \/ _ \/ __ `/ __ `__ \\__ \/ ___/ ___/ / __ \/ __/
 ___/ /  __/ /_/ / / / / / /__/ / /__/ /  / / /_/ / /_
/____/\___/\__,_/_/ /_/ /_/____/\___/_/  /_/ .___/\__/
- - - - - - - - - - - - - - - - - - - - - /_/ - - - - -
```

SeamScript is a strict superset of TypeScript where data from outside your program can't be used until it's checked. Files use the `.seam.ts` / `.seam.tsx` extensions, and the compiler, `seamc`, outputs plain, human-readable TypeScript.

Data from outside (`res.json()`, `res.text()`, `JSON.parse`, `localStorage.getItem`, `URLSearchParams.get`, `MessageEvent.data`, IndexedDB, the clipboard, files, `location.hash`, `history.state`, `document.cookie`, and whatever else you declare) has the type `Unknown`, and you can't use it until you check it with `decode`. IDs above 2^53, money amounts, time zone offsets, and the way "one character" is counted each cross the boundary in a dedicated type. With `latest`, an old response can no longer overwrite a newer screen.

```ts
export boundary Order {
  id: Int64;          // exact even above 2^53 (bigint)
  memo: Text<NFC> maxLength 200;  // normalized; length is counted in graphemes
  total: Decimal;     // exact decimal, no rounding error
  placedAt: Zoned;    // timestamp with a UTC offset
  status: "open" | "paid";
}

export async function load(id: string) {
  const res = await fetch(`/orders/${id}`);
  const r = decode Order from json await res.text();   // Result<Order, DecodeError>, malformed JSON included
  if (!r.ok) return `${r.error.path.join(".")}: ${r.error.expected} expected, got ${r.error.actual}`;
  return Decimal.toFixed(r.value.total, 2);
}

// When a new call starts, the result of the older call becomes Stale and never reaches the screen.
export latest async function search(q: Text<NFC>, signal: AbortSignal) {
  const res = await fetch(`/search?q=${q}`, { signal });
  return decode Order[] from await res.json();
}
```

If you cast the result of `res.json()` with `as Order`, assign it to a `string` variable, or let it escape into `unknown`, both `seamc check` and the editor report an error (SEAM2001 and others).

## Only five additions to the syntax

| Syntax | Meaning |
|---|---|
| `boundary Name { ... }` / `boundary Name = A \| B` | Declares the type of data that crosses the boundary and its checker (decoder) at the same time. A field's type can be followed by constraints: `matches /re/`, `minLength N`, `maxLength N`, `in A..B`. `Name.encode(value)` also turns a value into the form you send |
| `decode T from v` / `decode T from json text` | Checks `v` and returns `Result<T, DecodeError>`. Never throws. With `json`, it parses the text first, and malformed JSON is a `DecodeError` too |
| `latest async function` | Returns only the result of the most recent call. Older calls become `Stale`, and they are aborted if the function has an `AbortSignal` parameter |
| `Unknown` | The type of data from outside. Its only exit is `decode` |
| `Text<NFC \| NFD>`, `Int64`, `Decimal`, `Zoned` | Boundary types. At runtime they are plain strings or bigints, so they work directly with `===` and in JSX |

Anything else is added as runtime library functions (`Text.slice`, `Decimal.div`, and so on), not as syntax.

## Getting started

SeamScript is not published on npm yet (the `@seamscript` scope has not been claimed). For now, build this repository and use the packages from the workspace.

```bash
nix-shell --run 'yarn install --frozen-lockfile && yarn build'
```

The toolchain (Node 24, TypeScript 5.9, Rust with wasm32) is defined in `shell.nix`. Without nix, you need Node 20 or later, yarn 1, and Rust with `rustup target add wasm32-unknown-unknown` already run.

Once the packages are published, a new app starts with one command (Vite + React, or `--template vanilla` for Vite alone), and an existing project installs the packages:

```bash
npm create seamscript my-app
npm install @seamscript/runtime @seamscript/core
npm install --save-dev @seamscript/compiler @seamscript/ts-plugin typescript
```

### Type checking

A `.seam.ts` file is a TypeScript file, so the `include` in your `tsconfig.json` picks it up as is. In CI, use `seamc check` instead of `tsc`; it also runs the SeamScript checks.

```bash
npx seamc check -p tsconfig.json
npx seamc check -p tsconfig.json --watch
```

### Bundlers

Vite:

```ts
// vite.config.ts
import seamscript from "@seamscript/compiler/vite";
export default { plugins: [seamscript()] };
```

esbuild, Rollup, Rolldown, webpack, Rspack, Rsbuild, Bun:

```ts
import { esbuild, rollup, rolldown, webpack, rspack } from "@seamscript/compiler/unplugin";
// e.g. plugins: [esbuild()] for esbuild, plugins: [webpack()] for webpack
```

The plugins only convert `.seam.ts` into TypeScript. The bundler strips the types (with webpack, your project's TS loader does), and `seamc check` does the type checking. In production builds, each module that uses Text (a `Text` field or decode, or a `Text.` call, in `.seam.ts` files and in plain `.ts` files that import `@seamscript/runtime`) gets an import of the WASM core (`@seamscript/core`); a bundle without Text carries no core. `seamc build --production` adds the import to the `.seam.ts` files it writes; a plain `.ts` file that uses Text there needs `import "@seamscript/core"` written in it, or once in the entry point.

### More sources of outside data

The common web APIs are sources already. Declare your own in `tsconfig.json`, as `Owner.member` (an interface, class, namespace or object type, and its method or property) or as a bare function or variable name. A call that returns a promise gives `Promise<Unknown>`.

```jsonc
{
  "compilerOptions": { ... },
  "seamscript": {
    "sources": ["NativeBridge.receive", "AppStore.load", "readConfig"],
    // "unknown" (the default): a library's `any` is an error until decoded (SEAM2005). "allow" lets it through.
    "externalAny": "unknown"
  }
}
```

With `"externalAny": "unknown"`, a value whose declared type is `any` in a package's type declarations (`axios`'s `response.data`, for example) is reported where it is used, with a quick fix that decodes it.

### Value constraints

A boundary field's type can be followed by constraints, checked when the value is decoded (and by `encode`, which throws `EncodeRangeError` for a value that would not decode again):

```ts
export boundary Signup {
  handle: string matches /^[a-z][a-z0-9_]{2,15}$/;
  name: Text<NFC> minLength 1 maxLength 40;    // grapheme clusters, after normalization
  port: number in 1..65535;                    // both ends included
  quota: Int64 in 0..1_000_000;
  tags: string[] maxLength 10;                 // elements
  nickname?: Text<NFC> | null maxLength 20;    // checked when present and not null
}
```

`matches` takes string and Text fields (the usual `RegExp.test`, so anchor the pattern with `^` and `$` to match the whole value); `minLength` and `maxLength` take Text (grapheme clusters) and arrays (elements); `in` takes number and Int64. A plain `string` has no length constraint: declare the field `Text<NFC>` to count characters. The type stays as declared (`port` is a `number`); a failed constraint is a `DecodeError` such as `expected: "number in 1..65535", actual: "number (out of range)"`, which never quotes the value itself.

### Editors

- **VS Code**: install the extension (`packages/vscode`). `yarn build` produces `packages/vscode/dist/seamscript-0.0.0.vsix`; install it with `code --install-extension`.
- **Other editors that use tsserver**: add `"plugins": [{ "name": "@seamscript/ts-plugin" }]` to `tsconfig.json`.

Completion, hover types, go to definition, rename, and both TypeScript and SeamScript diagnostics work through `boundary` and `decode`. Every SeamScript message says how to fix it, and the mechanical fixes are quick fixes: decoding a value assigned to a typed variable (`const o: Order = JSON.parse(s)` becomes `const o = decode Order from JSON.parse(s)`), `Text.length(t)` and `Text.at(t, i)` for code-unit access, `Order.encode(o)` inside `JSON.stringify`, and `AbortSignal` for a latest function's signal parameter.

### React

`@seamscript/react` gives a component its own line of a latest function: `const find = useFork(search)`. Its calls make only that component's earlier calls stale, and unmounting cancels whatever is in flight.

## Things to know for production

- **Your CSP needs `'wasm-unsafe-eval'`.** Text normalization and grapheme segmentation run in a WASM core pinned to one Unicode version (Unicode 17.0.0). If your CSP forbids WebAssembly, the core can't load and Text operations throw `CoreUnavailableError` (they never silently fall back to the browser's ICU). At startup, check whether `Text.status` is `"failed"` and tell the user on screen.

  ```
  Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'
  ```

- **`latest` guarantees ordering only when you apply the result in the first continuation right after `await`.** If you put another `await` between receiving the result and applying it, an old result can be applied after a newer one.

  ```ts
  const r = await search(q);
  if (r.ok) setResults(r.value);    // good: apply it as soon as you receive it
  // await somethingElse();          // waiting here before applying breaks the ordering guarantee
  ```

- **The core is loaded before your app's code runs.** The production import of `@seamscript/core` instantiates the WASM with a top-level await, so the modules that use Text (and everything that imports them) start after it: about 90KB gzipped to download and about 10 ms to compile and instantiate on a desktop machine. To start without waiting, use `seamscript({ core: "deferred" })` in Vite (or `seamc build --production --defer-core`): the core then loads in the background, `Text.status` is `"loading"` until it is ready, and Text operations on anything but printable ASCII throw `CoreUnavailableError` (with `loading: true`) until then. Await `Text.ready` before the first one:

  ```ts
  await Text.ready;                   // settles when the core is loaded, or has failed
  if (Text.status === "failed") showError();
  ```

- **Parse JSON inside decode.** `res.json()` and `JSON.parse` throw on malformed input; `decode T from json text` returns it as a `DecodeError` (`expected: "JSON"`) like any other bad input.

  ```ts
  const r = decode Order from json await res.text();
  if (!r.ok) return r.error;          // malformed JSON or the wrong shape
  ```

- **On a WebSocket, decode the frame as JSON text.** `e.data` is `Unknown`; a binary frame is a `DecodeError` with `expected: "JSON text"`.

  ```ts
  ws.onmessage = (e) => {
    const msg = decode ServerMessage from json e.data;
    if (msg.ok) apply(msg.value);
  };
  ```

- **Mixing a branded value with plain strings in an array literal gives `string[]`.** TypeScript keeps the wider of two types when one contains the other, so `[m.label, m.placedAt]` (a `string` and a `Zoned`) is `string[]` and `placedAt` loses its brand. Two different brands stay apart (`(Zoned | Text<"NFC">)[]`). To keep each element's type, annotate a tuple or use `as const`:

  ```ts
  const row: [string, Zoned] = [m.label, m.placedAt];
  const same = [m.label, m.placedAt] as const;   // readonly [string, Zoned]
  ```

- **On the dev server, Text runs on the browser's ICU** (the WASM core isn't loaded, so startup is fast). `Text.status` is then `"host"`, and the Unicode version depends on the browser. In production builds it is `"core"`.

## Packages

| Package | Contents |
|---|---|
| [`@seamscript/runtime`](packages/runtime) | Decoders, `Result`, `latest`, Text, Int64, Decimal, Zoned, `Unknown` |
| [`@seamscript/core`](packages/core) | WASM core for Text normalization and grapheme segmentation (Unicode 17.0.0). The backend can use it too, as the Rust crate `seamscript-core` |
| [`@seamscript/compiler`](packages/compiler) | `seamc` (check / build / transform), plugins for Vite and unplugin |
| [`@seamscript/parser`](packages/parser) | A fork of `@babel/parser` with SeamScript syntax added |
| [`@seamscript/ts-plugin`](packages/ts-plugin) | tsserver plugin (editor support, quick fixes) |
| [`@seamscript/react`](packages/react) | `useFork`: a component's own line of a latest function |
| [`create-seamscript`](packages/create-seamscript) | `npm create seamscript`: a new app with Vite, `seamc check` and the WASM core |
| [`seamscript` (VS Code extension)](packages/vscode) | The tsserver plugin plus syntax highlighting |

## This repository

```bash
nix-shell --run 'yarn test'            # tests for all packages, plus the comparison demo
nix-shell sandbox/e2e/shell.nix --run 'yarn sandbox'        # E2E tests of the sandbox app (3 browsers)
nix-shell sandbox/e2e/shell.nix --run 'yarn sandbox:bench'  # benchmarks and budget checks
```

- [`demo/`](demo): a comparison demo that writes the same bugs in TypeScript (strict + Zod + ESLint) and in SeamScript, and shows that only SeamScript stops them
- [`sandbox/`](sandbox): a real-time dashboard written entirely in SeamScript, and a mock backend that does fault injection. E2E and benchmark results are in [sandbox/README.md](sandbox/README.md)
- [`DECISIONS.md`](DECISIONS.md): a record of what the initial specification didn't say and what was changed from it

## License

MIT ([LICENSE](LICENSE)). `@seamscript/parser` is a fork of `@babel/parser` (MIT) and includes Babel's license.
