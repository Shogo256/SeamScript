// Offsets between a source and its transform output, for tools that work in
// offsets rather than line/column pairs (an editor's language service).
import { decodedMappings, TraceMap } from "@jridgewell/trace-mapping";
import type { SourceMap } from "magic-string";

/** `length` characters at `source` in the original are the same characters at `generated` in the output. */
export interface CodeRange {
  source: number;
  generated: number;
  length: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** Every segment of the map as [generated offset, source offset], in generated order. */
export function segmentOffsets(source: string, code: string, map: SourceMap): [generated: number, source: number][] {
  const lines = decodedMappings(new TraceMap(map as unknown as ConstructorParameters<typeof TraceMap>[0]));
  const gen = lineStarts(code);
  const src = lineStarts(source);
  const out: [number, number][] = [];
  lines.forEach((segments, line) => {
    for (const seg of segments) if (seg.length >= 4) out.push([gen[line]! + seg[0], src[seg[2]!]! + seg[3]!]);
  });
  return out;
}

/**
 * Where the output repeats the source exactly. The transform only inserts and
 * overwrites, and its map has a segment for every character it kept (hires), so
 * runs of segments that advance together over equal text are the kept text.
 */
export function identityRanges(source: string, code: string, map: SourceMap): CodeRange[] {
  const points = segmentOffsets(source, code, map);
  const out: CodeRange[] = [];
  for (let i = 0; i < points.length; i++) {
    const [g, s] = points[i]!;
    // A point covers the characters up to the next point when both sides advance alike.
    const next = points[i + 1];
    const length = next !== undefined && next[0] - g === next[1] - s && next[0] > g ? next[0] - g : 1;
    if (code.slice(g, g + length) !== source.slice(s, s + length) || g + length > code.length || s + length > source.length) continue;
    const last = out.at(-1);
    if (last !== undefined && last.generated + last.length === g && last.source + last.length === s) last.length += length;
    else out.push({ source: s, generated: g, length });
  }
  return out;
}
