# 比較デモ

仕様書の「最初のマイルストーン」のデモです。同じ画面（注文の読み込み、メモのプレビュー、検索）を、TypeScript strict ＋ Zod ＋ ESLint と SeamScript の両方で書いています。仕様書が挙げた3つのバグが、ユーザーに届く前に止まるかを比べます。

```bash
nix-shell --run 'yarn build && yarn demo'
```

```
バグ                             TS + Zod + ESLint       SeamScript
1. unknown 経由で as Order       ✗ tsc・ESLint とも通過  ✓ SEAM2001 で停止
2. 絵文字を slice(0, 10) で切る  ✗ 文字が割れる          ✓ 割れない
3. 古い応答で画面が戻る          ✗ 古い結果が残る        ✓ 最新の結果が残る
```

## 何を確かめているか

`ts-zod-eslint/test/bugs.test.ts` と `seamscript/test/bugs.test.ts` は、同じタイトルのテストを3本ずつ持っています。各テストは「そのバグがユーザーに届く前に止まるか」を確かめます。TS 側は3本とも失敗し、SeamScript 側は3本とも通ります。CI（`.github/workflows/comparison-demo.yml`）でも、TS 側のジョブは赤、SeamScript 側のジョブは緑になります。

TS 側では、`tsc --strict` と ESLint はどちらもエラーを出しません（`yarn workspace @seamscript-demo/ts-zod-eslint lint`）。型検査と lint をすべて通ったうえで、バグが残るということです。

### 1. unknown 経由の `as Order`（コンパイル時）

`src/load-order.ts` と `src/load-order.seam.ts` は、拡張子以外まったく同じコードです。

```ts
const v = await res.json();
const u: unknown = v;
screen.order = u as Order;
```

TS 側は、Zod のスキーマがあるのに、この経路だけが検証を飛ばします。`tsc --strict` も、typescript-eslint の recommended もこれを通します。SeamScript では `res.json()` が Unknown 型になるので、`const u: unknown = v` の行が SEAM2001 になります。

typescript-eslint の `no-unsafe-type-assertion` を有効にすれば、TS 側でも止まることは確認済みです。ただしこのルールは recommended にも strict にも入っておらず（入っているのは `all` だけ）、型情報つきの lint も必要です。SeamScript との違いは、設定に依らず常に止まることです。

SeamScript での正しい書き方は `decode` です。

```ts
const r = decode Order from await res.json();
if (r.ok) screen.order = r.value;
```

### 2. 絵文字を `slice(0, 10)` で切る（実行時）

`"お誕生日おめでとう🎂ケーキ"` の先頭 10 文字をプレビューにすると、TS 側は UTF-16 の単位で切るので、🎂 が半分に割れます（`"お誕生日おめでとう\ud83c…"`）。SeamScript 側は `Text.slice(memo, 0, 10)` で、グラフェム（見た目の1文字）単位で切ります。Text に対して TS と同じ `memo.slice(0, 10)` と書くと、それ自体がコンパイルエラー（TS2349）になります。`memo.length` も SEAM2101 で止まります。

### 3. 古い応答で画面が戻る（実行時）

`"ab"` から `"abc"` へ打ち替えたとき、`"ab"` の応答が後から届くケースです。テストでは応答の返る順を固定したモック fetch を使うので、毎回同じ結果になります。TS 側は後から届いた `"ab"` の結果で画面が上書きされます。SeamScript 側は `latest async function` なので、古い呼び出しが Stale になり、`"abc"` の結果が残ります。

`latest` が保証するのは、呼び出し側が `await` の直後に結果を反映する場合です。反映する前にもう一度 `await` を挟むと、順序は保証されません（TLC で確認。`packages/runtime/spec/`）。

## 構成

| パス | 内容 |
|---|---|
| `ts-zod-eslint/` | TS 版。`tsconfig.json`（strict）と `eslint.config.js`（typescript-eslint recommended） |
| `seamscript/` | SeamScript 版。テストは Vite プラグイン経由で `.seam.ts` を読む |
| `shared/harness.ts` | 両側のテストが共有する道具：応答順を固定する fetch、文字の切れ目の判定 |
| `run.mjs` | 両側を実行して表を出す。TS 側は3つとも素通り、SeamScript 側は3つとも停止、という想定どおりのときだけ終了コード 0 |
