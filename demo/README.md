# Comparison demo

This is the demo for the "first milestone" in the initial specification (which is not included in this repository). The same screen (loading an order, previewing a memo, search) is written both in TypeScript strict + Zod + ESLint and in SeamScript. The demo compares whether the three bugs that the specification lists are stopped before they reach the user.

```bash
nix-shell --run 'yarn build && yarn demo'
```

```
Bug                               TS + Zod + ESLint        SeamScript
1. as Order via unknown           ✗ passes tsc and ESLint  ✓ stopped by SEAM2001
2. slice(0, 10) on an emoji memo  ✗ splits a character     ✓ no split
3. a stale response wins          ✗ stale result shown     ✓ latest result shown
```

## What it checks

`ts-zod-eslint/test/bugs.test.ts` and `seamscript/test/bugs.test.ts` each have three tests with the same titles. Each test checks whether the bug is stopped before it reaches the user. All three fail on the TS side, and all three pass on the SeamScript side. CI (`.github/workflows/comparison-demo.yml`) checks the same split: the TS job passes when its three tests fail, the SeamScript job passes when its three tests pass, and a third job runs `yarn demo`.

On the TS side, neither `tsc --strict` nor ESLint reports an error (`yarn workspace @seamscript-demo/ts-zod-eslint lint`). In other words, the bugs remain even though the code passes every type check and lint rule.

### 1. `as Order` via unknown (compile time)

`src/load-order.ts` and `src/load-order.seam.ts` contain exactly the same code, apart from the file extension.

```ts
const v = await res.json();
const u: unknown = v;
screen.order = u as Order;
```

On the TS side, there is a Zod schema, yet this one path skips validation. Both `tsc --strict` and typescript-eslint's recommended config let it through. In SeamScript, `res.json()` has the type Unknown, so the line `const u: unknown = v` is reported as SEAM2001.

Enabling typescript-eslint's `no-unsafe-type-assertion` does stop it on the TS side too; this has been verified. But the rule is in neither recommended nor strict (only in `all`), and it also needs type-aware linting. The difference is that SeamScript always stops it, whatever the configuration.

The correct way to write this in SeamScript is with `decode`.

```ts
const r = decode Order from await res.json();
if (r.ok) screen.order = r.value;
```

### 2. Cutting an emoji with `slice(0, 10)` (runtime)

When the first 10 characters of `"お誕生日おめでとう🎂ケーキ"` are used as a preview, the TS side cuts in UTF-16 units, so 🎂 is split in half (`"お誕生日おめでとう\ud83c…"`). The SeamScript side uses `Text.slice(memo, 0, 10)`, which cuts by grapheme (one visible character). Writing the TS version, `memo.slice(0, 10)`, on a Text is itself a compile error (TS2349). `memo.length` is also stopped, by SEAM2101.

### 3. A stale response rolls the screen back (runtime)

This is the case where the user changes `"ab"` to `"abc"` and the response for `"ab"` arrives later. The tests use a mock fetch with a fixed response order, so the result is the same every time. On the TS side, the late `"ab"` result overwrites the screen. On the SeamScript side, the function is a `latest async function`, so the old call becomes Stale and the `"abc"` result stays.

`latest` guarantees this when the caller applies the result right after `await`. If another `await` comes before the result is applied, ordering is not guaranteed (confirmed with TLC; see `packages/runtime/spec/`).

## Layout

| Path | Contents |
|---|---|
| `ts-zod-eslint/` | The TS version. `tsconfig.json` (strict) and `eslint.config.js` (typescript-eslint recommended) |
| `seamscript/` | The SeamScript version. The tests load `.seam.ts` through the Vite plugin |
| `shared/harness.ts` | Tools shared by the tests on both sides: a fetch with a fixed response order, and detection of character breaks |
| `run.mjs` | Runs both sides and prints the table. Exits with code 0 only when the result is as expected: the TS side lets all three bugs through and the SeamScript side stops all three |
