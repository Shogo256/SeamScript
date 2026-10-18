# @seamscript/compiler

The SeamScript compiler. It converts `.seam.ts` / `.seam.tsx` into plain TypeScript and adds the SeamScript checks on top of TypeScript's type checking.

## seamc

```bash
seamc check [-p tsconfig.json] [-w] [files...]
seamc build [-p tsconfig.json] --outDir <dir> [--production] [-w]
seamc transform <file.seam.ts>
seamc --help | --version
```

- `check`: type-checks the project. Use it instead of `tsc --noEmit`. Exits with code 1 if there are errors.
- `build`: if checking passes, writes each `.seam.ts` to `--outDir` as plain TypeScript. File names don't change, so `import "./order.seam"` still resolves. With `--production`, each file imports `@seamscript/core` (the WASM core).
- `transform`: prints the output for one file.
- `-w` / `--watch`: checks again whenever a file or tsconfig.json changes. Files whose text hasn't changed are not parsed or transformed again.
- `--help` (also `seamc` on its own) and `--version`: in a terminal they start with the SeamScript logo; piped or in CI they print plain text only.

Checking runs in two passes. The first pass finds the sources of outside data (`res.json()`, `JSON.parse` and so on, identified by their declarations in TypeScript's lib), and the second pass type-checks them as `Unknown`. It takes about 1.2 to 1.4 times as long as tsc on the same program.

## Diagnostics

| Code | Meaning |
|---|---|
| SEAM1000 | Syntax error |
| SEAM1101 | A type that can't cross a boundary (in a field or as a decode target: functions, any, generic types, and so on) |
| SEAM1102 | A boundary can only appear at the top level of a module |
| SEAM1103 | A boundary can contain only fields |
| SEAM1104 | The members of a union boundary must be boundary names |
| SEAM1105 | A union member has no discriminant field |
| SEAM1106 | A type that isn't a boundary is referenced as a boundary |
| SEAM1201 | Reserved (an invalid decode target is reported as SEAM1101) |
| SEAM1301 | A Text other than `Text<NFC>` / `Text<NFD>` |
| SEAM1401 | A latest function can't be a generator |
| SEAM1402 | The type of a latest function's AbortSignal parameter isn't written as `AbortSignal` |
| SEAM2001 | Unknown flows to an exit other than decode (`as`, assignment to `unknown` or `any`, templates, `+`, `in`, `throw`, and so on) |
| SEAM2002 | A call that takes Unknown and returns any / unknown |
| SEAM2003 | A method that is a source of outside data is referenced without being called |
| SEAM2004 | A property that is a source of outside data is destructured |
| SEAM2101 | Access to a Text in UTF-16 units (`.length`, indexing, `.slice`, and so on) |
| SEAM2201 | A value containing a bigint is passed to `JSON.stringify` (pass `Order.encode(o)` instead) |

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

The `core` option decides whether each module imports `@seamscript/core`. For Vite, the default is on only for `vite build` (the dev server and Vitest run on the environment's ICU). For the other bundlers, the default is on.

## Node API

```ts
import { createSeamProgram, transform } from "@seamscript/compiler";

const r = transform(source, "order.seam.ts");        // { code, map, diagnostics, links, syntaxError }
const p = createSeamProgram(rootNames, compilerOptions);
p.diagnostics();                                      // SeamScript and TypeScript diagnostics (positions in the original source)
```

`createChecker(ts)` from `@seamscript/compiler/checker` creates a checker that runs on the TypeScript you pass in (the editor plugin passes tsserver's TypeScript).
