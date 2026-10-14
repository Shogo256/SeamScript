# @seamscript/runtime

The SeamScript runtime. Code that the compiler outputs imports it. Inside `.seam.ts`, the values `Text`, `Int64`, `Decimal`, `Zoned`, `Unknown` and `fetch`, and the types `Result`, `Ok`, `Err`, `DecodeError` and `Stale`, are imported automatically (`ok` and `err` have generic names, so you import them yourself).

## Result and decode

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type DecodeError = { kind: "decode"; path: string[]; expected: string; actual: string };
```

`decode T from v` never throws; it returns `Result<T, DecodeError>`. `path` is where it failed (`["orders", "3", "price"]`), `expected` is the type it wanted, and `actual` is the name of the actual type. The value itself is never included (so personal data doesn't end up in logs). The exception is a mismatched literal: for strings of 40 characters or fewer and for numbers, the value is shown, as in `"pending"`.

- Nesting is limited to 512 levels (`MAX_DEPTH`). Deeper input returns a failure.
- Only own properties are read. Exceptions thrown by getters or Proxies are also returned as a failure (`"unreadable"`).
- Fields that aren't in the boundary are dropped, so the backend can add fields without breaking anything.
- A boundary name is also a value. `Order.encode(order)` returns a shape you can pass straight to `JSON.stringify` (an Int64 becomes a string; if it is out of range, `EncodeRangeError` is thrown).

## Boundary types

At runtime they are all plain strings or bigints, so they work directly with `===`, as Map keys, and as JSX children. decode and each type's `from` return values in canonical form (`"12.50"` becomes `"12.5"`).

| Type | At runtime | Accepts | Main functions |
|---|---|---|---|
| `Int64` | bigint | Numbers that are safe integers, and integer strings in canonical form (`"007"` and `"-0"` are rejected) | `Int64.MIN` / `MAX` / `inRange` |
| `Decimal` | string | Decimal strings (exponent notation is rejected) | `from`, `add`, `sub`, `mul`, `div`, `round`, `compare`, `toFixed` |
| `Zoned` | string | ISO 8601 with an offset (`Z` or `±HH:MM`; `-00:00` is rejected) | `from`, `fromDate`, `toDate`, `epochNanoseconds`, `offsetMinutes`, `sameInstant`, `compare` |
| `Text<NFC>` / `Text<NFD>` | string | Well-formed UTF-16 (lone surrogates are rejected) | `nfc`, `nfd`, `length`, `at`, `slice`, `graphemes` |

### Decimal

Sums, differences and products are always exact. For division, you specify how many decimal places to keep and how to round. The rounding modes have the same names as `roundingMode` in `Intl.NumberFormat`, and the default is `"halfExpand"` (halves round away from zero).

```ts
const unit = Decimal.div(Decimal.from("10"), Decimal.from("3"), 2);            // "3.33"
const fair = Decimal.div(Decimal.from("1"), Decimal.from("8"), 2, "halfEven");  // "0.12"
Decimal.toFixed(Decimal.from("2.5"), 0, "halfEven");                            // "2"
```

### Text

Length and slicing count graphemes (the unit a person sees as one character). `length`, indexing, `slice` and the other operations that count in UTF-16 units are not available on the type (`seamc check` reports an error).

```ts
const memo = Text.nfc(input);       // normalize (lone surrogates are replaced with U+FFFD)
Text.length(memo);                  // number of graphemes
Text.slice(memo, 0, 32);            // the first 32 graphemes
Text.at(memo, -1);                  // the last grapheme
```

In production builds these are computed by `@seamscript/core` (WASM, Unicode 17.0.0), so every browser and server gets the same result. `Text.status` is one of `"core"` (the WASM core), `"host"` (development; the environment's ICU), or `"failed"` (the core couldn't load; Text operations throw `CoreUnavailableError`).

## latest

A `latest async function` returns only the result of the most recent call. Earlier calls become `Stale` (`{ ok: false, error: { kind: "stale" } }`) when they finish, and if the last parameter is an `AbortSignal`, they are aborted (callers don't pass that argument).

```ts
const r = await search(q);
if (!r.ok && r.error.kind === "stale") return;   // a newer search has started
```

`search.fork()` returns a copy with its own, independent generation. Keep one per component and call `cancel()` on unmount; every call made through that copy then becomes `Stale`. For a generic function, fix the type arguments, as in `search.fork<T>()`. The guarantee holds only when you apply the result in the first continuation right after `await` (don't put another `await` in between).

## Unknown and fetch

`Unknown` is the type of data from outside, and its only exits are `decode` and `Unknown.log(v)` (for debugging; it only prints the value). Inside `.seam.ts`, `fetch` comes from this package: underneath it is the global `fetch`, but `res.json()` has the type `Promise<Unknown>`.
