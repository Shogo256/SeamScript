# @seamscript/parser: a fork of @babel/parser

- Source: `packages/babel-parser/src` in `babel/babel`, tag `v8.0.7`, commit `1fc00736614159e3b236b9958771f482899853f0`
- License: MIT (`LICENSE` is upstream's, unchanged)

## Differences from upstream

Keep the differences limited to these.

| File | Change |
|---|---|
| `src/plugins/seamscript.ts` | New. A mixin that parses `boundary` / `decode … from` / `latest` |
| `src/plugin-utils.ts` | Registers the mixin (right after typescript) and checks that "seamscript requires typescript". The changed lines are marked `SeamScript` |
| `src/typings.d.ts`, `typings/babel-parser.d.ts` | Adds the plugin name `"seamscript"` |

The build uses esbuild (`scripts/build.mjs`), not upstream's Babel build. It reproduces the three transforms that upstream applies at build time.

- `process.env.IS_PUBLISH = true`
- Replace `charCodes.x` (constants from the `charcodes` package) with numbers (babel-plugin-transform-charcodes). If they are bundled as is, the inner loop of the tokenizer calls a CommonJS getter every time, and parsing becomes about 1.8 times slower
- Expand the `@bit` decorators in `tokenizer/state.ts` into getters / setters that use bitwise operations

## Checking that the fork doesn't break anything

`yarn test` checks three things.

1. The upstream fixtures (about 6,000 inputs; `scripts/fetch-fixtures.sh` fetches them from the same commit) are parsed with both the published `@babel/parser@8.0.7` and the fork. With and without `errorRecovery`, the AST, the recovered errors and the thrown errors must match exactly.
2. For the TypeScript fixtures (about 700), the results must still match upstream exactly with the seamscript plugin enabled. This checks principle 1 of the initial specification: SeamScript syntax doesn't change the meaning of existing TS.
3. The parse results of the new syntax, and that TS using `decode` / `boundary` / `latest` as ordinary identifiers is not affected (`test/seamscript.test.ts`).

## Following upstream

1. Replace `src/` with `packages/babel-parser/src` from the new tag.
2. Reapply the changes in the table above. `seamscript.ts` can be used as is.
3. Update `COMMIT` in `scripts/fetch-fixtures.sh` and the version of `@babel/parser` (a devDependency) in `package.json` to match.
4. Run `yarn test`. When the differential tests pass, the update is complete.
