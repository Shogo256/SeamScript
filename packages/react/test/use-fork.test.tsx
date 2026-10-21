// @vitest-environment happy-dom
import { __latest, type Result, ok } from "@seamscript/runtime";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFork } from "../src/index.js";

// React only runs effects synchronously inside act() when it knows it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A latest function whose calls settle only when the test says so; each records its AbortSignal. */
function controlled() {
  const calls: { q: string; signal: AbortSignal; settle(): void }[] = [];
  const search = __latest(
    (q: string, signal: AbortSignal) =>
      new Promise<Result<string, never>>((resolve) => {
        calls.push({ q, signal, settle: () => resolve(ok(q.toUpperCase())) });
      }),
    { signal: 1 },
  );
  return { search, calls };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("useFork", () => {
  it("returns the same fork on every render", async () => {
    const { search } = controlled();
    const seen: unknown[] = [];
    function Box({ n }: { n: number }) {
      seen.push(useFork(search));
      return <span>{n}</span>;
    }
    await render(<Box n={1} />);
    await render(<Box n={2} />);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toBe(search);
  });

  it("gives each component its own line: one's calls do not make the other's stale", async () => {
    const { search, calls } = controlled();
    const forks: ReturnType<typeof search.fork>[] = [];
    function Box() {
      forks.push(useFork(search));
      return null;
    }
    await render(
      <>
        <Box />
        <Box />
      </>,
    );
    const [a, b] = forks;
    const first = a!("a");
    const second = b!("b");
    for (const c of calls) c.settle();
    expect(await first).toEqual(ok("A"));
    expect(await second).toEqual(ok("B"));
  });

  it("keeps only a component's latest call", async () => {
    const { search, calls } = controlled();
    let find!: ReturnType<typeof search.fork>;
    function Box() {
      find = useFork(search);
      return null;
    }
    await render(<Box />);
    const older = find("a");
    const newer = find("ab");
    expect(calls[0]!.signal.aborted).toBe(true);
    for (const c of calls) c.settle();
    expect(await older).toMatchObject({ ok: false, error: { kind: "stale" } });
    expect(await newer).toEqual(ok("AB"));
  });

  it("cancels what is in flight when the component unmounts", async () => {
    const { search, calls } = controlled();
    let find!: ReturnType<typeof search.fork>;
    function Box() {
      find = useFork(search);
      return null;
    }
    await render(<Box />);
    const pending = find("a");
    await render(null);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.settle();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "stale" } });
  });

  it("makes a new fork for a different function and cancels the old one", async () => {
    const one = controlled();
    const two = controlled();
    let find!: (q: string) => Promise<unknown>;
    let swap!: () => void;
    function Box() {
      const [fn, setFn] = useState(() => one.search);
      swap = () => setFn(() => two.search);
      find = useFork(fn);
      return null;
    }
    await render(<Box />);
    const before = find;
    const pending = find("a");
    await act(() => swap());
    expect(find).not.toBe(before);
    expect(one.calls[0]!.signal.aborted).toBe(true);
    one.calls[0]!.settle();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "stale" } });
    const next = find("b");
    two.calls[0]!.settle();
    expect(await next).toEqual(ok("B"));
  });

  it("still works after StrictMode's extra effect cleanup in development", async () => {
    const { search, calls } = controlled();
    let find!: ReturnType<typeof search.fork>;
    function Box() {
      find = useFork(search);
      return null;
    }
    await render(
      <StrictMode>
        <Box />
      </StrictMode>,
    );
    const r = find("a");
    expect(calls[0]!.signal.aborted).toBe(false);
    calls[0]!.settle();
    expect(await r).toEqual(ok("A"));
  });
});
