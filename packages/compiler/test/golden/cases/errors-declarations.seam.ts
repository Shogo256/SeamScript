// Each declaration error once (the SEAM1xxx codes).
import { ok } from "@seamscript/runtime";
type Plain = { a: string };
interface Shape { b: number }

boundary BadFields {
  f: () => void,
  a: any,
  u: undefined,
  n: { x: number },
  g: Array<string>,
  t: Text,
  k: Text<NFKC>,
  p: Plain,
  m(): void,
  s: string maxLength 3,
  r: number in 10..1,
  re: string matches /x/g,
  audio: Pcm<Int24, 16000, 1>,
  planar: Planar<Int16, 1>,
}

boundary A { kind: "same" }
boundary B { kind: "same" }
boundary NoDiscriminant = A | B
boundary Mixed = A | Int64
boundary NotOne = A | Shape

export function nested() {
  boundary Inside { a: string }
  return 1;
}

export latest async function* stream() {
  yield ok(1);
}

type Signal = AbortSignal;
export latest async function withAlias(q: string, signal: Signal) {
  void signal;
  return ok(q);
}
