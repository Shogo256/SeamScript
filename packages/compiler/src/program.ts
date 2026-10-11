// A TypeScript program over a project that contains `.seam.ts` files. The compiler
// host serves each `.seam.ts` file as its transformed TypeScript, so module
// resolution and type checking work unchanged, and every diagnostic is mapped
// back to the original source through the transform's source map.
//
// The program is built twice (the spec's checker pass): the first build finds the
// expressions that bring in outside data, those are wrapped in `__unknown(...)` in
// the original source's coordinates (so there is still one source map per file),
// and the second build, which reuses every unchanged file, is type-checked and
// checked for Unknown flows. tsc runs twice, so checking costs roughly 2× plain tsc.
import { decodedMappings, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import ts from "typescript";
import { checkFlows, type Finding, findSources } from "./checker.js";
import type { Diagnostic } from "./diagnostics.js";
import { isSeamFile, RUNTIME_MODULE, type TransformResult, transform, type UnknownWrap } from "./transform.js";

export interface SeamProgram {
  /** The final (second) program. */
  program: ts.Program;
  /** The transform result of every `.seam.ts` file the program loaded, as emitted. */
  outputs: ReadonlyMap<string, TransformResult>;
  /** SeamScript and TypeScript diagnostics, positioned in the original sources. */
  diagnostics(): Diagnostic[];
}

function seamHost(host: ts.CompilerHost, transformed: (fileName: string) => TransformResult | undefined): ts.CompilerHost {
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  return {
    ...host,
    readFile: (fileName) => (isSeamFile(fileName) ? transformed(fileName)?.code : readFile(fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      if (!isSeamFile(fileName)) return getSourceFile(fileName, languageVersion, onError, shouldCreate);
      const r = transformed(fileName);
      return r === undefined ? undefined : ts.createSourceFile(fileName, r.code, languageVersion, true);
    },
  };
}

export function createSeamProgram(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  host: ts.CompilerHost = ts.createCompilerHost(options),
): SeamProgram {
  const originals = new Map<string, string | undefined>();
  const original = (fileName: string) => {
    if (!originals.has(fileName)) originals.set(fileName, host.readFile(fileName));
    return originals.get(fileName);
  };

  // Pass 1: plain transform.
  const first = new Map<string, TransformResult>();
  const host1 = seamHost(host, (f) => {
    if (!first.has(f)) {
      const source = original(f);
      if (source === undefined) return undefined;
      first.set(f, transform(source, f));
    }
    return first.get(f);
  });
  const program1 = ts.createProgram(rootNames, options, host1);

  const wraps = new Map<string, UnknownWrap[]>();
  const pending: Diagnostic[] = [];
  for (const [fileName, r] of first) {
    const sf = program1.getSourceFile(fileName);
    if (r.syntaxError || sf === undefined) continue;
    const { sites, findings } = findSources(program1, sf);
    const map = new TraceMap(r.map as unknown as ConstructorParameters<typeof TraceMap>[0]);
    pending.push(...findings.map((f) => fromFinding(f, fileName, sf, map)));
    const source = original(fileName)!;
    const mapped = sites.flatMap((site) => {
      const start = originalOffset(map, sf, source, site.start);
      const last = originalOffset(map, sf, source, site.end - 1);
      return start === undefined || last === undefined ? [] : [{ start, end: last + 1, async: site.async }];
    });
    if (mapped.length > 0) wraps.set(fileName, mapped);
  }

  // Pass 2: files with sources are transformed again with their wraps.
  const outputs = new Map<string, TransformResult>();
  const host2 = seamHost(host, (f) => {
    if (!outputs.has(f)) {
      const w = wraps.get(f);
      const reuse = first.get(f);
      if (w === undefined && reuse !== undefined) outputs.set(f, reuse);
      else {
        const source = original(f);
        if (source === undefined) return undefined;
        outputs.set(f, transform(source, f, { wraps: w }));
      }
    }
    return outputs.get(f);
  });
  const program = ts.createProgram(rootNames, options, host2, program1);

  return {
    program,
    outputs,
    diagnostics() {
      const out: Diagnostic[] = [...pending];
      const maps = new Map<string, TraceMap>();
      const mapOf = (fileName: string, r: TransformResult) => {
        let m = maps.get(fileName);
        if (m === undefined) maps.set(fileName, (m = new TraceMap(r.map as unknown as ConstructorParameters<typeof TraceMap>[0])));
        return m;
      };
      for (const [fileName, r] of outputs) {
        out.push(...r.diagnostics);
        const sf = program.getSourceFile(fileName);
        if (r.syntaxError || sf === undefined) continue;
        const runtime = ts.resolveModuleName(RUNTIME_MODULE, fileName, options, host2).resolvedModule?.resolvedFileName;
        for (const f of checkFlows(program, sf, runtime)) out.push(fromFinding(f, fileName, sf, mapOf(fileName, r)));
      }
      for (const d of ts.getPreEmitDiagnostics(program)) {
        const r = d.file && outputs.get(d.file.fileName);
        // A file that failed to parse was passed through unchanged; its syntax error is enough.
        if (r?.syntaxError) continue;
        out.push(fromTs(d, r ? mapOf(d.file!.fileName, r) : undefined));
      }
      return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
    },
  };
}

function fromFinding(f: Finding, fileName: string, sf: ts.SourceFile, map: TraceMap): Diagnostic {
  const pos = sf.getLineAndCharacterOfPosition(f.pos);
  return { file: fileName, ...originalPosition(map, pos.line, pos.character), code: f.code, message: f.message, category: "error" };
}

function fromTs(d: ts.Diagnostic, map: TraceMap | undefined): Diagnostic {
  const category = d.category === ts.DiagnosticCategory.Warning ? "warning" : "error";
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return { file: "", line: 1, column: 1, code: `TS${d.code}`, message, category };
  const pos = d.file.getLineAndCharacterOfPosition(d.start);
  const { line, column } = map ? originalPosition(map, pos.line, pos.character) : { line: pos.line + 1, column: pos.character + 1 };
  return { file: d.file.fileName, line, column, code: `TS${d.code}`, message, category };
}

/**
 * Original 1-based position of a 0-based generated position. Text that only exists
 * in the output (the runtime import, a boundary's decoder constant, the lines of a
 * latest wrapper) has no mapping of its own and is attributed to the nearest
 * mapped position before it.
 */
export function originalPosition(map: TraceMap, line: number, column: number): { line: number; column: number } {
  const p = originalPositionFor(map, { line: line + 1, column });
  if (p.line !== null) return { line: p.line, column: p.column + 1 };
  const lines = decodedMappings(map);
  for (let l = Math.min(line - 1, lines.length - 1); l >= 0; l--) {
    const seg = lines[l]?.at(-1);
    if (seg !== undefined && seg.length >= 4) return { line: seg[2]! + 1, column: seg[3]! + 1 };
  }
  return { line: 1, column: 1 };
}

/** The exact original offset of a generated offset that lies in unchanged source text, or undefined. */
function originalOffset(map: TraceMap, sf: ts.SourceFile, source: string, offset: number): number | undefined {
  const pos = sf.getLineAndCharacterOfPosition(offset);
  const p = originalPositionFor(map, { line: pos.line + 1, column: pos.character });
  if (p.line === null) return undefined;
  let lineStart = 0;
  for (let l = 1; l < p.line; l++) lineStart = source.indexOf("\n", lineStart) + 1;
  return lineStart + p.column;
}

/** Compiler options for checking SeamScript sources when no tsconfig.json is given. */
export const defaultCompilerOptions: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};
