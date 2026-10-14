// The virtual code tsserver sees in place of a .seam.ts file: the compiler's
// output, plus the ranges Volar maps between it and the source.
import type { CodeInformation, CodeMapping, IScriptSnapshot, VirtualCode } from "@volar/language-core";
import { type CodeRange, identityRanges } from "@seamscript/compiler/mappings";
import { transform, type TransformResult, type UnknownWrap } from "@seamscript/compiler/transform";

/** On text the transform kept, everything TypeScript offers applies. */
const KEPT: CodeInformation = { verification: true, completion: true, semantic: true, navigation: true, structure: true, format: true };
/**
 * A name the transform rewrote around (a boundary's decoder constant, a decode
 * target, a latest wrapper): hover, navigation, rename and completion, but no
 * diagnostics from the generated code around it, which is not the user's.
 */
const LINKED: CodeInformation = { completion: true, semantic: true, navigation: true };

export type CodeState =
  /** The compiler's output for the current source. */
  | "transformed"
  /**
   * The source does not parse (while typing): the last output with the same edit
   * applied, so TypeScript's error-tolerant parser still sees the transformed
   * constructs around the edit.
   */
  | "patched"
  /** The source does not parse and there was no output to patch: the source itself. */
  | "raw";

export interface SeamCode extends VirtualCode {
  readonly fileName: string;
  readonly source: string;
  readonly code: string;
  readonly kept: readonly CodeRange[];
  readonly links: readonly CodeRange[];
  /** Outside-data sites wrapped in `__unknown(...)`, in source offsets. */
  readonly wraps: readonly UnknownWrap[];
  readonly state: CodeState;
  /** The transform's diagnostics, by line and column in `source`. */
  readonly diagnostics: TransformResult["diagnostics"];
}

function snapshotOf(text: string): IScriptSnapshot {
  return { getText: (start, end) => text.slice(start, end), getLength: () => text.length, getChangeRange: () => undefined };
}

function make(
  fileName: string,
  source: string,
  code: string,
  kept: readonly CodeRange[],
  links: readonly CodeRange[],
  wraps: readonly UnknownWrap[],
  state: CodeState,
  diagnostics: TransformResult["diagnostics"],
): SeamCode {
  const mapping = (r: CodeRange, data: CodeInformation): CodeMapping => ({ sourceOffsets: [r.source], generatedOffsets: [r.generated], lengths: [r.length], data });
  return {
    id: "root",
    languageId: fileName.endsWith(".tsx") ? "typescriptreact" : "typescript",
    snapshot: snapshotOf(code),
    mappings: [...kept.map((r) => mapping(r, KEPT)), ...links.map((r) => mapping(r, LINKED))],
    fileName,
    source,
    code,
    kept,
    links,
    wraps,
    state,
    diagnostics,
  };
}

/** One contiguous edit: `old[start, oldEnd)` became `new[start, newEnd)`. */
export interface Edit {
  start: number;
  oldEnd: number;
  newEnd: number;
}

/** The smallest single edit that turns `a` into `b` (common prefix and suffix), or undefined if equal. */
export function diff(a: string, b: string): Edit | undefined {
  if (a === b) return undefined;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
  return { start, oldEnd: a.length - tail, newEnd: b.length - tail };
}

/** Ranges after the edit move with it; ranges it touches are dropped. */
export function shiftWraps(wraps: readonly UnknownWrap[], e: Edit): UnknownWrap[] {
  const delta = e.newEnd - e.oldEnd;
  return wraps.flatMap((w) =>
    w.end <= e.start ? [w] : w.start >= e.oldEnd ? [{ ...w, start: w.start + delta, end: w.end + delta }] : [],
  );
}

function patch(prev: SeamCode, source: string): Pick<SeamCode, "code" | "kept" | "links" | "wraps"> | undefined {
  const e = diff(prev.source, source);
  if (e === undefined) return prev;
  // The edit must fall inside kept text, where source and output are the same.
  const host = prev.kept.find((r) => r.source <= e.start && e.oldEnd <= r.source + r.length);
  if (host === undefined) return undefined;
  const delta = e.newEnd - e.oldEnd;
  const g = host.generated + (e.start - host.source);
  const gEnd = host.generated + (e.oldEnd - host.source);
  const move = (r: CodeRange): CodeRange => ({
    source: r.source >= e.oldEnd ? r.source + delta : r.source,
    generated: r.generated >= gEnd ? r.generated + delta : r.generated,
    length: r.length,
  });
  const touches = (r: CodeRange) => r.source < e.oldEnd && e.start < r.source + r.length;
  return {
    code: prev.code.slice(0, g) + source.slice(e.start, e.newEnd) + prev.code.slice(gEnd),
    kept: prev.kept.flatMap((r) => (r === host ? [{ ...r, length: r.length + delta }] : touches(r) ? [] : [move(r)])),
    links: prev.links.flatMap((r) => (touches(r) ? [] : [move(r)])),
    wraps: shiftWraps(prev.wraps, e),
  };
}

export function createSeamCode(fileName: string, snapshot: IScriptSnapshot, wraps: readonly UnknownWrap[], previous?: SeamCode): SeamCode {
  const source = snapshot.getText(0, snapshot.getLength());
  const r = transform(source, fileName, { wraps });
  if (!r.syntaxError) return make(fileName, source, r.code, identityRanges(source, r.code, r.map), r.links, wraps, "transformed", r.diagnostics);
  const patched = previous === undefined ? undefined : patch(previous, source);
  if (patched !== undefined) return make(fileName, source, patched.code, patched.kept, patched.links, patched.wraps, "patched", r.diagnostics);
  return make(fileName, source, source, [{ source: 0, generated: 0, length: source.length }], [], [], "raw", r.diagnostics);
}

/**
 * The source offset of a generated offset: exact in kept text and links, else
 * the end of the nearest kept text before it (where an error in generated code,
 * such as a boundary's decoder constant, is attributed).
 */
export function toSource(code: SeamCode, generated: number): number {
  for (const r of [...code.kept, ...code.links]) {
    if (r.generated <= generated && generated < r.generated + r.length) return r.source + (generated - r.generated);
  }
  let best: CodeRange | undefined;
  for (const r of code.kept) if (r.generated + r.length <= generated && (best === undefined || r.generated > best.generated)) best = r;
  return best === undefined ? 0 : best.source + best.length;
}

/** The exact source offset of a generated offset in kept text, or undefined. */
export function toSourceExact(code: SeamCode, generated: number): number | undefined {
  const r = code.kept.find((x) => x.generated <= generated && generated < x.generated + x.length);
  return r === undefined ? undefined : r.source + (generated - r.generated);
}
