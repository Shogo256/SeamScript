# 決定記録

仕様書（初版・11ページ版）に書かれていないこと、仕様から変えたことを記録する。仕様 v2 にまとめて反映する前提の一時置き場。

## 仮決め（レビューで挙げた点）

| # | 決めたこと | 理由 |
|---|---|---|
| P1 | core が読めないとき、データが原因の失敗は今までどおり Result で返し、`CoreUnavailableError` だけは `decode` からも投げる。core の入口は top-level await を reject させず、失敗したら `__coreFailed(cause)` を呼ぶ。ランタイム側の受け口は `__installCore` / `__coreFailed` | top-level await が reject するとアプリ全体の評価が止まり、`CoreUnavailableError` まで届かない。CSP 設定ミスは環境の問題なので、各 `r.ok` 分岐で扱わせるより大きく落とす方がよい |
| P2 | `latest` の `cancel()` 後に終わった呼び出しは、最新のものでも Stale | アンマウント時の cancel で AbortError が呼び出し側に漏れないようにする |
| P3 | `encode` で Int64 が範囲外なら `EncodeRangeError`（`RangeError` のサブクラス。`path` 付き）を投げる | `JSON.stringify(Order.encode(o))` とそのまま書けるようにする。範囲外は演算のバグなので例外が妥当 |
| P4 | Decimal は正規化を維持し、表示用に `Decimal.toFixed(d, digits)` を足す。丸めは halfExpand（`Intl.NumberFormat` の既定と同じ）で、負のゼロは出さない | `===` の値比較を残しつつ、金額表示の桁を回復する |

開発ビルドのコンパイラは `@seamscript/core` を import しないので、開発中は常にフォールバック（`Intl.Segmenter` と `normalize`）で動く。そのとき `Text.deterministic` は `false`、`Text.unicodeVersion` は `null`。

## 実装中に決めたこと

### 仕様から変えたもの

- **`Text.concat` の代わりに `Text.nfc(...parts)` / `Text.nfd(...parts)`**。実行時の Text はただの文字列なので、値を見ても NFC か NFD かを判別できない（ASCII はどちらも満たす）。NFC の文字列同士を連結しても NFC になるとは限らない（`"e"` + `"́"`）ので、連結後にどちらへ正規化し直すかを呼び出し側が指定する必要がある。
- **boundary 定数には型注釈を付けて出力する**：`export const Order: ObjectDecoder<Order> = __b.object<Order>({...})`。仕様の出力例のように注釈がないと、再帰する boundary（`__b.lazy(() => Order)`）が TS7022（自分の初期化子で参照されている）になる。union は `Decoder<Event>`。
- **`latest` の signal 指定は `{ signal: true }` ではなく `{ signal: <引数の位置> }`**。「最後の引数」と決めると、その前の省略可能引数が省略されたときに signal が別の引数の位置にずれる。位置はコンパイラが知っている。
- **型の印は `__seam` という文字列キーではなく、export しない `unique symbol`**。文字列キーだと、実在しない `t.__seam` が型の上では読めてしまう。
- **`Unknown.inspect` は `Unknown.log` に置き換わっている**（改訂版の仕様どおり）。`void` を返す。

### 仕様に書かれていなかったもの

- **Text**：decode は不正な UTF-16（孤立サロゲート）を拒否する。コンストラクタ（`Text.nfc` など）は失敗させず U+FFFD に置き換える（UTF-8 ベースの WASM core でも同じ結果になる）。印字可能な ASCII は分割処理を通さない（どの Unicode バージョンでも1文字1グラフェム）。
- **Int64**：文字列は正準形だけを受ける。`"007"`、`"-0"`、`"+1"`、指数表記は拒否する。ゼロ埋めの文字列はたいてい数値ではなくコードなので、黙って `7n` にしない。
- **Decimal**：指数表記（`"1E+3"`）は拒否する。→ 未決にも記載。
- **Zoned の正規形**：秒は常に出す。小数部は末尾のゼロを落とし、最大9桁。オフセット0は `Z` と書く。`-00:00`（RFC 3339 で「オフセット不明」）、`24:00`、閏秒、存在しない日付は拒否する。区切りは `T` / `t` のみ。`Zoned.compare` は瞬間だけで比べる（オフセットだけ違う値は 0）。
- **`Decimal.from` / `Zoned.from`** はプログラム内のリテラル用で、不正なら `SyntaxError` を投げる。外から来た文字列は `decode` を通す。
- **DecodeError.actual** は型名を返し、値は出さない（ログに個人情報が混ざるのを避ける）。例外はリテラルの不一致で、40 文字以下の文字列と数値だけ値を見せる（`"pending"` vs `"paid" | "open"`）。
- **decode の入れ子は 512 段まで**（`MAX_DEPTH`）。超えたら失敗として返す。スタックオーバーフローを防ぎ、postMessage で来る循環データも止める。
- **decode は自分のプロパティだけを読む**（`constructor` という名前のフィールドが欠けていても prototype を読まない）。`__proto__` キーは prototype を書き換えないように書く。getter や Proxy が投げる例外は `"unreadable"` という失敗にする。
- optional のフィールドに自分のプロパティとして `undefined` が入っていたら（postMessage 経由）、キーが無いのと同じに扱う。
- `Decoder` の内部書き出しはメソッド構文にしてある。これで `Decoder<Order>` を `Decoder<unknown>` として扱える（union のメンバーやデコーダの配列）。

## 検証で分かったこと

- `latest` の「画面が戻らない」は、**呼び出し側が `await` の直後の最初の継続で結果を反映する場合に限って**保証される。結果を受け取ったあと反映する前に、もう一度 `await` すると順序は保証されない。TLC で、配送が FIFO でなければ反例が出ることを確認した（`spec/latest_unordered.cfg`）。README に書くべきこと。コンパイラの警告にもできる。
- 正規化済みのテキストをグラフェム境界で切った断片は、正規化されたままになる。プロパティテストで NFC と NFD の両方を確認した。`Text.slice` / `at` / `graphemes` は正規化し直さない。

## 未決

### コンパイラ側（ランタイムには影響しない）

1. `Text` の `length` と添字の読み出しは、型の上では `never` になるだけでエラーにならない。checker に「Text への UTF-16 メンバーのアクセスはエラー」という規則を足す（`test/types.check.ts` に現状を固定してある）。
2. `function launder<T>(x: T): unknown` を経由した抜け道。戻り値に `any` を含むものだけでなく、`unknown` / `{}` / `object` を返す呼び出しにも Unknown を渡せないようにする。
3. `Storage.getItem` / `URLSearchParams.get` を発生源に残すなら、decode の対象に `T | null` も書けるようにする（ランタイムでは `__b.nullable` で表現できる）。
4. 「TS の API を4つに絞る」は現実的でない。`getResolvedSignature` / `getContextualType` / `getAliasedSymbol` が必要になる。checker API を1つのモジュールに閉じ込める方針にする。

### 仕様書の文言

- 一行定義の「正しい TypeScript はすべて正しい SeamScript」が、改訂した原則1と矛盾している。
- `seamscript/runtime` が3か所に残っている（原則2、コンパイル手順2、fetch の import 文）。
- 原則3の「DOM 入力」と、手順3(a)の `HTMLInputElement.value` が、4節と矛盾している。
- マイルストーンの名前確保の項目に `@seamscript` スコープが入っていない。
- 比較デモのバグ2は、Text だとコンパイル時に止まる（`t.slice` は `never` を呼ぶことになる）。
- 「やらないこと」の「二重アサーション拒否しか足さない」と、4節の「TS の unknown との違いは一つ」。
- **新たに見つけたもの**：decode の節の止めるバグの例「id を数値から文字列に変えたとき `expected: "int64", actual: "string"` が返る」。Int64 は数字だけの文字列を受け付けるので、`"123"` は通る。失敗するのは UUID のような数字でない文字列のとき。

### その他

- Decimal の指数表記。Java の `BigDecimal.stripTrailingZeros().toString()` や Python の `Decimal` は `"1E+3"` を出すことがある。受け付けるなら、指数の大きさに上限を設けたうえで展開する。
- 開発ビルドで `Intl.Segmenter` が無い環境では、コードポイント単位で分割している。
