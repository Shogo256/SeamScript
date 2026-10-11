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

## コンパイラで決めたこと

### パーサ（`packages/parser`）

- 仕様どおり `@babel/parser` を fork した（8.0.7）。ただし TS プラグインには手を入れず、`src/plugins/seamscript.ts` という新しい mixin を足して、`plugin-utils.ts` で登録するだけにした。upstream との差分はこの1ファイルと数行。追従手順は `packages/parser/UPSTREAM.md`。
- **fork が既存の TS の意味を変えていないこと**を、差分テストで確認している。upstream の約 6,000 のフィクスチャを、公開版 `@babel/parser@8.0.7` と fork の両方でパースし、AST と エラーが完全に一致すること。さらに TS のフィクスチャ約 700 については、seamscript プラグインを有効にしても一致すること。`errorRecovery` の有無の両方で比べている。
- `boundary` / `decode` / `latest` は、TS では構文エラーになる形（キーワードの直後に、同じ行で別の名前が続く）のときだけ構文として認識する。ただし直後が `as` / `satisfies` / `of` のときは普通の識別子のまま（`decode as T` は有効な TS なので）。
- `decode` の型の直後に `(` は書けない。`decode (A | null)[] from v` は関数呼び出し `decode(...)` と区別できないため。
- `export boundary` / `export latest` だけが export になる。仕様の出力例では export のない `boundary Order` が `export type` / `export const` になっているが、TS の他の宣言と同じく、明示したときだけ export する。

### 変換（`packages/compiler/src/transform.ts`）

- 出力は元のテキストに編集を差し込む形で作る（magic-string）。5構文以外は、コメントや書式も含めて1バイトも変わらない。ソースマップは1つだけ。checker の `__unknown(...)` で包む箇所も元のソースの座標で同じ変換に入れるので、仕様の「2段のソースマップ」は1段になる。
- boundary の定数には型注釈を付ける（`const Order: ObjectDecoder<Order> = ...`。前回の記録どおり）。
- boundary のフィールドからほかの boundary を参照するとき：同じファイルで先に宣言されていれば直接参照し、それ以外（自分自身、後で宣言されるもの、import したもの）は `__b.lazy(() => X)` にする。import の循環でも、初期化前の参照（TDZ）にならない。
- union boundary の判別フィールドは、ランタイムが初回使用時に自分で探す（`__b.union<T>(() => [A, B])`）。コンパイラは型情報なしで動くので、別ファイルのメンバーの中身を知らない。メンバーが全部同じファイルにあるときは、コンパイル時にも判別フィールドを検査する（SEAM1105）。
- `latest` の出力は次の3つ。`function f(...args) { return __latestFor(f__impl, opts).apply(undefined, args) }`、`f.fork = ...`、`async function f__impl(...)`。spread でなく `apply` にしたのは、checker が Unknown の spread を禁じており、latest 関数が Unknown を引数に取るのは正当なため。
- signal の有無は構文で判定する。最後の引数の型注釈が `AbortSignal` という名前かどうか。型の別名を経由した `AbortSignal` は検出できない。
- 自動で import するランタイムの名前は2種類。値は `Text` / `Int64` / `Decimal` / `Zoned` / `Unknown` / `fetch`、型は `Result` / `Ok` / `Err` / `DecodeError` / `Stale`。そのファイルが同じ名前を自分で束縛していない（import も宣言もしていない）ときだけ足す。`ok` / `err` は名前が一般的すぎるので、自動では import しない。
- `seamc build` の出力は、ファイル名を `x.seam.ts` のまま変えない。中身は素の TS だが、ほかのファイルの `import "./x.seam"` が書き換えなしで解決できる。
- decode の対象には、組み込み型、boundary 名、`T[]` に加えて、`T | null` とリテラル型も書ける（未決だった3を解決）。

### checker パス（`packages/compiler/src/checker.ts`）

- TypeChecker API を使うのはこの1ファイルだけ（未決だった4を解決）。使っている API は、`getSymbolAtLocation`、`getTypeAtLocation`、`getContextualType`、`getResolvedSignature`、`getTypeArguments`、`getPropertiesOfType`、`getTypeOfSymbol`、`isTypeAssignableTo`、`isTupleType`、`isArrayLikeType`、`getIndexTypeOfType`、`getAwaitedType`、`getExportsOfModule`、`getAliasedSymbol`、`getDeclaredTypeOfSymbol`。`typescript` は 5.9.3 に固定している。
- 発生源は TS の lib の宣言で判定する。対象は `Body.json`（Response と Request）、`JSON.parse`、`Storage.getItem`、`URLSearchParams.get` / `getAll`、`MessageEvent.data`（postMessage、WebSocket、BroadcastChannel）。DOM の入力値は対象にしない。改訂版4節に従ったもので、コンパイル手順3(a)の一覧は古い。
- 発生源のプロパティを分割代入で取り出すこと（`const { data } = e`）は、追跡せずエラーにする（SEAM2004）。束縛要素を Unknown 型に置き換える方法がないため。
- 流出検査は許可リスト方式。Unknown を含む式が流れ込んでよいのは、`decode`、`Unknown.log`、それから流入先の文脈型でも同じ位置に Unknown が残る場所だけ。エラーになるのは、`as`、unknown / any / {} / object / `Object` への代入、型のない関数への引数、`throw`、テンプレート文字列、`+` による連結、`in` 演算子、それに Unknown を消す先への spread。`in` を入れたのは、`"id" in v` で `{ id: unknown }` に絞り込まれて、decode を経ずに抜けられるため。
- 「Unknown を受け取って any / unknown / {} / object を返す呼び出し」はエラーにする（SEAM2002）。未決だった2を解決し、`launder<T>(x: T): unknown` 経由の抜け道も塞いだ。
- TypeScript 自体が代入を拒否する場合（Unknown は string に代入できない、など）は、TS のエラーに任せて重複して報告しない。ただし `as` は例外で、TS2352 と SEAM2001 の両方が出る。
- Text の `length` と添字の読み出し、それから UTF-16 単位のメソッドを呼ばずに参照することは、エラーにする（SEAM2101。未決だった1を解決）。メソッドの呼び出しは TS がもともと拒否する。
- `JSON.stringify` の検査は、引数の型に bigint を含むときだけにした（SEAM2201）。Text / Decimal / Zoned は実行時にはただの文字列なので、壊れない。

### 診断コード

| コード | 内容 |
|---|---|
| SEAM1000 | 構文エラー |
| SEAM1101 | boundary を越えられない型 |
| SEAM1102 | boundary はモジュールの最上位にしか書けない |
| SEAM1103 | boundary に書けるのはフィールドだけ |
| SEAM1104 | union boundary のメンバーは boundary 名だけ |
| SEAM1105 | union のメンバーに判別フィールドがない |
| SEAM1106 | boundary でない型を、boundary として参照した |
| SEAM1301 | `Text<NFC>` / `Text<NFD>` 以外の Text |
| SEAM1401 | latest 関数はジェネレータにできない |
| SEAM2001 | Unknown が decode 以外の出口へ流れた |
| SEAM2002 | Unknown を受け取って any / unknown を返す呼び出し |
| SEAM2003 | 発生源のメソッドを、呼び出さずに参照した |
| SEAM2004 | 発生源のプロパティを分割代入した |
| SEAM2101 | Text への UTF-16 単位のアクセス |
| SEAM2201 | bigint を含む値を JSON.stringify に渡した |

## 検証で分かったこと

- `latest` の「画面が戻らない」は、**呼び出し側が `await` の直後の最初の継続で結果を反映する場合に限って**保証される。結果を受け取ったあと反映する前に、もう一度 `await` すると順序は保証されない。TLC で、配送が FIFO でなければ反例が出ることを確認した（`spec/latest_unordered.cfg`）。README に書くべきこと。コンパイラの警告にもできる。
- 正規化済みのテキストをグラフェム境界で切った断片は、正規化されたままになる。プロパティテストで NFC と NFD の両方を確認した。`Text.slice` / `at` / `graphemes` は正規化し直さない。
- 仕様の出力例 `export const Order = __b.object<Order>({...})` は、再帰する boundary だと TS7022 になる（前回の記録）。

## 未決

### コンパイラの既知の制限

- ジェネリックな `latest` 関数は、公開側のシグネチャで型引数を失う（`Parameters<typeof f__impl>` が unknown で具体化される）。
- `Text<NFC>` の書き換えは、名前が `Text` の型参照すべてに適用する。そのファイルが別の `Text` を import していても書き換えてしまう。
- 一度目の program は発生源を見つけるためだけに作っている。チェックの時間は素の tsc の約2倍。
- 既存の `.ts` ファイルから来る `any` は検査の対象外（仕様の「既存コードの境界は守れない」）。

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
