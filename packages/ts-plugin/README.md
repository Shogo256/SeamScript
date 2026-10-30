# @seamscript/ts-plugin

A plugin for TypeScript's language service (tsserver). When you write `.seam.ts` / `.seam.tsx` in an editor, it makes TypeScript's features (completion, hover types, go to definition, references, rename, type errors) work through `boundary`, `decode` and `latest`, and it reports SeamScript diagnostics (the same ones as `seamc check`, with the project's `"seamscript"` settings from `tsconfig.json`).

## Quick fixes

Each fix is offered on the diagnostic it repairs, and the fixed code checks clean:

| Diagnostic | Fix |
|---|---|
| SEAM2001, SEAM2005, and TypeScript's assignment errors (TS2322, TS2739–TS2741) on a variable with a boundary type | `const o: Order = JSON.parse(s)` becomes `const o = decode Order from JSON.parse(s)` (`o` is then a Result to check) |
| SEAM2101 | `t.length` becomes `Text.length(t)`; `t[i]` becomes `Text.at(t, i)` |
| SEAM2201 | `JSON.stringify(order)` becomes `JSON.stringify(Order.encode(order))`; an array of a boundary becomes `orders.map(Order.encode)` |
| SEAM1402 | The signal parameter's type becomes `AbortSignal` |

## Usage

In VS Code, installing the extension (`packages/vscode`) loads the plugin. In other editors that use tsserver (such as typescript-language-server in Neovim), add the plugin as a devDependency and list it in `tsconfig.json`.

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@seamscript/ts-plugin" }]
  }
}
```

## How it works

The plugin shows tsserver each `.seam.ts` as the plain TypeScript that `seamc` outputs, and maps positions back to the original file (using [Volar](https://volarjs.dev/)).

- The two-pass check that turns outside data into `Unknown` runs on the language service's program, repeating until the wrap positions settle (the program after wrapping finds the same positions, so one retry is enough).
- When the syntax breaks partway through typing, the plugin applies the current edit to the last state that transformed successfully, so completion and hover types keep working.
- For a file that has never transformed successfully, it doesn't report TypeScript's errors on SeamScript syntax (there would be a great many); it reports only SeamScript syntax errors.
- It uses tsserver's own TypeScript (the plugin doesn't bundle TypeScript). `seamc` checks with the TypeScript it pins (5.9), so when the editor's major or minor version differs, every `.seam.ts` file gets a warning at the top (SEAM9001): the type errors shown can differ from `seamc check`. In VS Code, "TypeScript: Select TypeScript Version" switches to the workspace's TypeScript.

The tests start the same tsserver that VS Code uses and drive it over its protocol (`test/plugin.test.ts`, `test/sandbox.test.ts`).
