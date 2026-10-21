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

Data from outside (`res.json()`, `JSON.parse`, `localStorage.getItem`, `URLSearchParams.get`, `MessageEvent.data`) has the type `Unknown`, and you can't use it until you check it with `decode`. IDs above 2^53, money amounts, time zone offsets, and the way "one character" is counted each cross the boundary in a dedicated type. With `latest`, an old response can no longer overwrite a newer screen.

```ts
export boundary Order {
  id: Int64;          // exact even above 2^53 (bigint)
  memo: Text<NFC>;    // normalized; length is counted in graphemes
  total: Decimal;     // exact decimal, no rounding error
  placedAt: Zoned;    // timestamp with a UTC offset
  status: "open" | "paid";
}

export async function load(id: string) {
  const res = await fetch(`/orders/${id}`);
  const r = decode Order from await res.json();   // Result<Order, DecodeError>
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
| `boundary Name { ... }` / `boundary Name = A \| B` | Declares the type of data that crosses the boundary and its checker (decoder) at the same time. `Name.encode(value)` also turns a value into the form you send |
| `decode T from v` | Checks `v` and returns `Result<T, DecodeError>`. Never throws |
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

Until then, a project outside this repository links the built packages from a checkout. List `@seamscript/parser` too: the compiler depends on it, and npm would otherwise look for it on the registry.

```json
"dependencies": {
  "@seamscript/core": "file:../SeamScript/packages/core",
  "@seamscript/runtime": "file:../SeamScript/packages/runtime"
},
"devDependencies": {
  "@seamscript/compiler": "file:../SeamScript/packages/compiler",
  "@seamscript/parser": "file:../SeamScript/packages/parser"
}
```

Once the packages are published, you install them like this:

```bash
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

The plugins only convert `.seam.ts` into TypeScript. The bundler strips the types (with webpack, your project's TS loader does), and `seamc check` does the type checking. In production builds, each module gets an import of the WASM core (`@seamscript/core`).

### Editors

- **VS Code**: install the extension (`packages/vscode`). `yarn build` produces `packages/vscode/dist/seamscript-0.0.0.vsix`; install it with `code --install-extension`.
- **Other editors that use tsserver**: add `"plugins": [{ "name": "@seamscript/ts-plugin" }]` to `tsconfig.json`.

Completion, hover types, go to definition, rename, and both TypeScript and SeamScript diagnostics work through `boundary` and `decode`.

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

- **JSON syntax errors are outside decode.** Both `res.json()` and `JSON.parse` throw on malformed input. `decode` returns only shape errors as values.

  ```ts
  let body: Unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "not json" } as const;
  }
  const r = decode Order from body;
  ```

- **On a WebSocket, go through `decode string from e.data`.** `e.data` is `Unknown`, so you can't pass it straight to `JSON.parse`. It is one extra step, but it lets you tell binary frames apart.

  ```ts
  ws.onmessage = (e) => {
    const text = decode string from e.data;
    if (!text.ok) return;                      // binary frame
    let raw: Unknown;
    try {
      raw = JSON.parse(text.value);
    } catch {
      return;                                  // malformed JSON
    }
    const msg = decode ServerMessage from raw;
    if (msg.ok) apply(msg.value);
  };
  ```

- **On the dev server, Text runs on the browser's ICU** (the WASM core isn't loaded, so startup is fast). `Text.status` is then `"host"`, and the Unicode version depends on the browser. In production builds it is `"core"`.

## Packages

| Package | Contents |
|---|---|
| [`@seamscript/runtime`](packages/runtime) | Decoders, `Result`, `latest`, Text, Int64, Decimal, Zoned, `Unknown` |
| [`@seamscript/core`](packages/core) | WASM core for Text normalization and grapheme segmentation (Unicode 17.0.0). The backend can use it too, as the Rust crate `seamscript-core` |
| [`@seamscript/compiler`](packages/compiler) | `seamc` (check / build / transform), plugins for Vite and unplugin |
| [`@seamscript/parser`](packages/parser) | A fork of `@babel/parser` with SeamScript syntax added |
| [`@seamscript/ts-plugin`](packages/ts-plugin) | tsserver plugin (editor support) |
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
