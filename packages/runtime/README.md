# @seamscript/runtime

The SeamScript runtime. Code that the compiler outputs imports it. Inside `.seam.ts`, the values `Text`, `Int64`, `Decimal`, `Zoned`, `Unknown` and `fetch`, and the types `Result`, `Ok`, `Err`, `DecodeError` and `Stale`, are imported automatically (`ok` and `err` have generic names, so you import them yourself).

## Result and decode

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type DecodeError = { kind: "decode"; path: string[]; expected: string; actual: string; rule: DecodeRule };
```

`decode T from v` never throws; it returns `Result<T, DecodeError>`. `path` is where it failed (`["orders", "3", "price"]`), `expected` is the type it wanted, and `actual` is the name of the actual type. The value itself is never included (so personal data doesn't end up in logs). The exception is a mismatched literal: for strings of 40 characters or fewer and for numbers, the value is shown, as in `"pending"`.

- `decode T from json text` parses `text` first. Malformed JSON is a failure with `expected: "JSON"` and `actual: "malformed JSON"` (the parser's message, which quotes the input, is not passed on), and input that is not a string has `expected: "JSON text"`.
- Constraints on boundary fields (`matches /re/`, `minLength`, `maxLength`, `in A..B`) fail with the field's whole expectation, as in `expected: "text of length 1..40"`, `actual: "length 41"`, or `expected: "string matching /^[a-z]+$/"`, `actual: "string (no match)"`.
- `rule` says which check failed, for code that reacts to the kind of failure: `"type"` (the wrong type), `"value"` (the right type with an unacceptable value: an unlisted literal, a non-canonical Int64 string), `"missing"`, `"unreadable"`, `"depth"`, `"json"`, `"pattern"` / `"length"` / `"range"` (constraints), `"nonFinite"`, and for audio `"format"`, `"sampleRate"`, `"channels"`, `"frameAlignment"`.
- Nesting is limited to 512 levels (`MAX_DEPTH`). Deeper input returns a failure.
- Only own properties are read. Exceptions thrown by getters or Proxies are also returned as a failure (`"unreadable"`).
- Fields that aren't in the boundary are dropped, so the backend can add fields without breaking anything.
- A boundary name is also a value. `Order.encode(order)` returns a shape you can pass straight to `JSON.stringify` (an Int64 becomes a string). A value that would not decode again throws `EncodeRangeError` with its path: an Int64 outside the 64-bit range, or a field that breaks its constraint.

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

In production builds these are computed by `@seamscript/core` (WASM, Unicode 17.0.0), so every browser and server gets the same result. `Text.status` is one of `"core"` (the WASM core), `"host"` (development; the environment's ICU), `"loading"` (`@seamscript/core/deferred` is still loading), or `"failed"` (the core couldn't load; Text operations throw `CoreUnavailableError`). While loading, Text operations on anything but printable ASCII throw `CoreUnavailableError` with `loading: true`; `Text.ready` is a promise that settles once the load has finished (successfully or not), and is already settled when nothing is loading.

```ts
await Text.ready;
if (Text.status === "failed") showError();
```

## Binary data and audio

| Type | Accepts | Value |
|---|---|---|
| `Bytes` | an ArrayBuffer or any view on one (not shared memory) | a `Uint8Array` over the same bytes |
| `Pcm<F, Rate, Channels>` | little-endian PCM bytes, the format's typed array (`Int16Array` / `Float32Array`), or a WAV file whose header matches | `{ format, sampleRate, channels, frames, samples }`, samples interleaved |
| `Planar<"float32", Channels>` | an array of one `Float32Array` per channel, all the same length | `{ format, channels, frames }`, the arrays themselves |

In `.seam.ts` the format is written `Int16` / `Float32` (`Pcm<Int16, 16000, 1>`) and compiles to `"int16"` / `"float32"`. Plain PCM bytes carry no sample rate or channel count, so those are taken as declared; a WAV header is checked against them. Float32 samples must be finite. `encode` gives what `WebSocket.send` and `postMessage` take: `Pcm` its little-endian bytes (an `ArrayBuffer`), `Bytes` itself, `Planar` its channel arrays. `Pcm.of(format, rate, channels, samples)` makes `Pcm` from samples the app produced (it throws if they don't fit). `Planar` does not copy: the audio thread reuses its arrays after `process` returns, so copy what you keep. `yarn bench` (`bench/process.ts`) times the decode as `process` would run it: about 0.4 µs for one 128-frame mono input and 0.7–0.9 µs for stereo in Node 24, against the 2,667 µs between calls at 48 kHz.

## ChunkStream

`ChunkStream.of(decoder, policy, onEvent)` decodes each chunk pushed into it and delivers them to `onEvent` in sequence order, once each.

| Policy | Default | Meaning |
|---|---|---|
| `seq(chunk)` | (required) | The chunk's sequence number, a safe integer |
| `first` | the first number that arrives | The number to start from |
| `gap: { wait, then }` | `{ wait: 0, then: "drop" }` | Hold later chunks up to `wait` ms for a missing number, then skip it; `"error"` also reports a `gap` event |
| `duplicate` | `"drop"` | A number already delivered or held |
| `late` | `"drop"` | A skipped number that arrives after all |
| `maxBuffer` | 64 | Held chunks at most; one more skips the oldest gap at once (`reason: "overflow"`) |

Events are `chunk`, `gap`, `duplicate`, `late` (the last three only when asked for with `"error"`) and `invalid` (a chunk that failed its boundary, always reported). `stats` counts everything, dropped chunks included. `reset(next?)` starts a new numbering (after a reconnect), `close()` stops the wait timer. Events are delivered after the stream's state is updated, so `onEvent` may push into the stream.

Delivered numbers strictly increase, a skipped number is never delivered later, and with nothing lost and no gap skipped everything is delivered: `spec/chunkstream.tla` checks this with TLC under reordering, duplication and loss (`chunkstream_accept_old.cfg` is a sanity check that must fail).

## Node.js: `@seamscript/runtime/node`

| Entry | Gives |
|---|---|
| `env.get(name)` | `process.env[name]`, also when it isn't set (it then decodes as `undefined`, which a target like `Int64` rejects) |
| `env.all()` | a copy of `process.env` as it is when called |
| `file.readText(path)` | the file's text (UTF-8), as a promise |
| `file.readJson(path)` | the file parsed as JSON; malformed JSON rejects with a SyntaxError naming only the path (`decode T from json await file.readText(path)` gives it as a DecodeError instead) |

Each returns an Unknown that hides its contents at run time as well: a Proxy around an empty object, with the value kept outside it. Reading a property, indexing, iterating, spreading, `Object.keys`, `in`, `JSON.stringify`, converting to a string or number, writing, deleting and defining properties all throw `UnknownAccess`, whose message names the operation, never the value. What stays possible: passing it around, awaiting a promise of it (its `then` reads as nothing), `console.log` (prints `[Unknown]`), `decode` (which reads the contents), and `Unknown.log` (prints them, for debugging). `Array.isArray`, the prototype and `typeof` are the same whatever is inside. File errors reject as `fs.readFile`'s do.

## latest

A `latest async function` returns only the result of the most recent call. Earlier calls become `Stale` (`{ ok: false, error: { kind: "stale" } }`) when they finish, and if the last parameter is an `AbortSignal`, they are aborted (callers don't pass that argument).

```ts
const r = await search(q);
if (!r.ok && r.error.kind === "stale") return;   // a newer search has started
```

`search.fork()` returns a copy with its own, independent generation. Keep one per component and call `cancel()` on unmount; every call made through that copy then becomes `Stale`. In React, `useFork(search)` from `@seamscript/react` does both. For a generic function, fix the type arguments, as in `search.fork<T>()`. The guarantee holds only when you apply the result in the first continuation right after `await` (don't put another `await` in between).

## Unknown and fetch

`Unknown` is the type of data from outside, and its only exits are `decode` and `Unknown.log(v)` (for debugging; it only prints the value). Which values are outside data is decided by the compiler: the web APIs that deliver it (`Body.json`, `text`, `arrayBuffer` and `bytes`, `Blob.arrayBuffer` and `bytes`, `MediaStreamTrack.getSettings`, an AudioWorklet's `process` inputs, `JSON.parse`, `Storage.getItem`, `URLSearchParams.get`, `MessageEvent.data`, `IDBRequest.result`, `Clipboard.readText`, `Blob.text`, `FileReader.result`, `Location.hash`, `History.state`, `Document.cookie`, and others), plus whatever the project declares in `tsconfig.json` (see `@seamscript/compiler`). Inside `.seam.ts`, `fetch` comes from this package: underneath it is the global `fetch`, but `res.json()` has the type `Promise<Unknown>`.
