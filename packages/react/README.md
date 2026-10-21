# @seamscript/react

React bindings for SeamScript.

## useFork

`useFork(search)` gives a component its own line of a latest function (`search.fork()`, made once per component). Its calls make only that component's earlier calls stale, so two mounted components never cancel each other's requests, and unmounting cancels whatever is still in flight: those calls resolve to `Stale` and, when the function takes an `AbortSignal`, their requests are aborted.

```tsx
import { useFork } from "@seamscript/react";

function SearchBox() {
  const find = useFork(search);
  const [hits, setHits] = useState<Hit[]>([]);

  async function onInput(q: Text<NFC>) {
    const r = await find(q);
    if (r.ok) setHits(r.value);   // apply right after the await; a Stale result is dropped
  }
  ...
}
```

- The same fork comes back on every render, so it can go in an effect's dependencies.
- Passing a different function makes a new fork and cancels the previous one.
- A fork stays usable after `cancel()`, so StrictMode's extra effect cleanup in development does no harm.
- It accepts anything with a `fork()` that returns something with `cancel()`, so a latest function's fork works the same way.

`react` 18 or later and `@seamscript/runtime` are peer dependencies.
