# @seamscript/parser: @babel/parser の fork

- 元：`babel/babel` の `packages/babel-parser/src`、タグ `v8.0.7`、コミット `1fc00736614159e3b236b9958771f482899853f0`
- ライセンス：MIT（`LICENSE` は upstream のものをそのまま置いている）

## upstream からの差分

差分はこれだけにとどめる。

| ファイル | 変更 |
|---|---|
| `src/plugins/seamscript.ts` | 新規。`boundary` / `decode … from` / `latest` を解析する mixin |
| `src/plugin-utils.ts` | mixin の登録（typescript の直後）と、「seamscript には typescript が必要」の検査。行に `SeamScript` の印 |
| `src/typings.d.ts`, `typings/babel-parser.d.ts` | プラグイン名 `"seamscript"` を追加 |

ビルドは upstream の Babel ビルドではなく、esbuild を使う（`scripts/build.mjs`）。upstream がビルド時に行う2つの変換を再現している。

- `process.env.IS_PUBLISH = true`
- `tokenizer/state.ts` の `@bit` デコレータを、ビット演算の getter / setter に展開する

## fork が壊していないことの確認

`yarn test` で次の3つを確認する。

1. upstream のフィクスチャ（約 6,000 入力。`scripts/fetch-fixtures.sh` が同じコミットから取得する）を、公開版の `@babel/parser@8.0.7` と fork の両方でパースする。`errorRecovery` の有無の両方で、AST、回復したエラー、投げたエラーが完全に一致すること。
2. TypeScript のフィクスチャ（約 700）について、seamscript プラグインを有効にしても、upstream と完全に一致すること。SeamScript の構文が既存の TS の意味を変えない、という原則1の確認。
3. 新しい構文の解析結果と、`decode` / `boundary` / `latest` を普通の識別子として使った TS が影響を受けないこと（`test/seamscript.test.ts`）。

## upstream に追従するとき

1. 新しいタグの `packages/babel-parser/src` で `src/` を置き換える。
2. 上の表の差分を当て直す。`seamscript.ts` はそのまま使える。
3. `scripts/fetch-fixtures.sh` の `COMMIT` と、`package.json` の `@babel/parser`（devDependency）のバージョンを揃える。
4. `yarn test`。差分テストが通れば追従は完了。
