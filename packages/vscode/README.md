# SeamScript for VS Code

An extension for writing SeamScript (`.seam.ts` / `.seam.tsx`) in VS Code.

- **TypeScript features work as usual**: completion, hover types, go to definition, find references, rename, and TypeScript type errors. They also work on `boundary` types, on the result of `decode Order from v`, and on calls to `latest` functions.
- **SeamScript diagnostics**: the same ones as `seamc check`. For example, a type that can't cross a boundary (SEAM1101), using Unknown without decoding it (SEAM2001), and reading a Text in UTF-16 units (SEAM2101). Each message says how to fix it.
- **Quick fixes** for the mechanical cases: decode a value assigned to a typed variable, `Text.length(t)` / `Text.at(t, i)` for code-unit access, `Order.encode(o)` inside `JSON.stringify`, and `AbortSignal` for a latest function's signal parameter.
- **Highlighting**: `boundary`, `decode … from`, `from json`, `latest`, and field constraints (`matches /re/`, `minLength`, `maxLength`, `in 1..10`) are highlighted.

Even when the syntax breaks partway through typing, analysis continues by applying the edit to the last state that transformed successfully, so completion and hover types keep working.

## How it works

The extension makes VS Code's built-in TypeScript language server (tsserver) load the plugin `@seamscript/ts-plugin`. The plugin replaces each `.seam.ts` with the plain TypeScript that `seamc` outputs, shows that to tsserver, and maps positions back to the original file (using [Volar](https://volarjs.dev/)). The extension itself contains no code.

It also works when VS Code is set to use the workspace's TypeScript version.

## Requirements

- `@seamscript/runtime` must be installed in the project (to resolve types).
