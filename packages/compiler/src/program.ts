// A TypeScript program over a project that contains `.seam.ts` files. The compiler
// host serves each `.seam.ts` file as its transformed TypeScript, so module
// resolution and type checking work unchanged, and every diagnostic is mapped
// back to the original source through the transform's source map.
//
// The program is built twice (the spec's checker pass): the first build finds the
// expressions that bring in outside data, those are wrapped in `__unknown(...)` in
// the original source's coordinates (so there is still one source map per file),
// and the second build, which reuses every unchanged file, is type-checked and
// checked for Unknown flows. The first build asks the type checker only about
// member accesses named like a source (json, parse, data, ...), so it costs a
// small part of a full check; without any source, it is the final build.
import { decodedMappings, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
// Loaded with require: importing TypeScript's CommonJS API as ESM makes Node
// scan all of it for export names first, about 100 ms on every run.
import ts = require("typescript");
import { type CheckerOptions, createChecker, type Finding } from "./checker.js";
import type { Diagnostic } from "./diagnostics.js";
import { isSeamFile, RUNTIME_MODULE, type TransformResult, transform, type UnknownWrap } from "./transform.js";

// One checker per set of options; most projects use the defaults.
const checkers = new Map<string, ReturnType<typeof createChecker>>();
function checkerFor(options: CheckerOptions): ReturnType<typeof createChecker> {
  const key = JSON.stringify(options);
  let c = checkers.get(key);
  if (c === undefined) checkers.set(key, (c = createChecker(ts, options)));
  return c;
}

export interface SeamProgram {
  /** The final (second) program. */
  program: ts.Program;
  /** The transform result of every `.seam.ts` file the program loaded, as emitted. */
  outputs: ReadonlyMap<string, TransformResult>;
  /** SeamScript and TypeScript diagnostics, positioned in the original sources. */
  diagnostics(): Diagnostic[];
}

/**
 * Source files are handed out once per file (per transform result for `.seam.ts`),
 * so the second program gets the first one's objects for everything that did not
 * change, and TypeScript reuses them parsed and bound instead of starting over
 * (lib.dom.d.ts alone is most of the parse time).
 */
type SourceFiles = {
  plain: Map<string, ts.SourceFile | undefined>;
  seam: WeakMap<TransformResult, ts.SourceFile>;
};

/**
 * What a watch keeps from one check to the next: parsed files and transform
 * results whose text did not change. Create one with `createSeamCache()` and pass
 * it to every `createSeamProgram` of the same project and options.
 */
export interface SeamCache {
  readonly plain: Map<string, { text: string; file: ts.SourceFile }>;
  readonly seam: WeakMap<TransformResult, ts.SourceFile>;
  readonly transforms: Map<string, { key: string; result: TransformResult }>;
}

export function createSeamCache(): SeamCache {
  return { plain: new Map(), seam: new WeakMap(), transforms: new Map() };
}

function seamHost(host: ts.CompilerHost, files: SourceFiles, transformed: (fileName: string) => TransformResult | undefined, cache?: SeamCache): ts.CompilerHost {
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const parse = (fileName: string, languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions, onError?: (message: string) => void, shouldCreate?: boolean) => {
    if (cache === undefined) return getSourceFile(fileName, languageVersion, onError, shouldCreate);
    const text = readFile(fileName);
    if (text === undefined) return undefined;
    const kept = cache.plain.get(fileName);
    if (kept?.text === text) return kept.file;
    const file = ts.createSourceFile(fileName, text, languageVersion);
    cache.plain.set(fileName, { text, file });
    return file;
  };
  return {
    ...host,
    readFile: (fileName) => (isSeamFile(fileName) ? transformed(fileName)?.code : readFile(fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      if (!isSeamFile(fileName)) {
        if (!files.plain.has(fileName)) files.plain.set(fileName, parse(fileName, languageVersion, onError, shouldCreate));
        return files.plain.get(fileName);
      }
      const r = transformed(fileName);
      if (r === undefined) return undefined;
      let sf = files.seam.get(r);
      if (sf === undefined) files.seam.set(r, (sf = ts.createSourceFile(fileName, r.code, languageVersion, true)));
      return sf;
    },
  };
}

export interface SeamProgramOptions {
  /** The project's "seamscript" settings (readSeamConfig). */
  checker?: CheckerOptions;
  /** Transform for production: `.seam.ts` files that use Text import `@seamscript/core`. */
  production?: boolean;
  /** With production, import `@seamscript/core/deferred` instead. */
  deferCore?: boolean;
  /** Reuse work from earlier programs of the same project (a watch). */
  cache?: SeamCache;
}

export function createSeamProgram(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  host: ts.CompilerHost = ts.createCompilerHost(options),
  { production = false, deferCore = false, cache, checker: checkerOptions = {} }: SeamProgramOptions = {},
): SeamProgram {
  const { findSources, checkFlows } = checkerFor(checkerOptions);
  // A transform depends only on the text, the wraps and the production options.
  const transformCached = (source: string, fileName: string, wraps: readonly UnknownWrap[] | undefined): TransformResult => {
    if (cache === undefined) return transform(source, fileName, { wraps, production, deferCore });
    const key = `${production}:${deferCore}:${JSON.stringify(wraps ?? [])}:${source}`;
    const kept = cache.transforms.get(`${fileName}\0${wraps === undefined ? 0 : 1}`);
    if (kept?.key === key) return kept.result;
    const result = transform(source, fileName, { wraps, production, deferCore });
    cache.transforms.set(`${fileName}\0${wraps === undefined ? 0 : 1}`, { key, result });
    return result;
  };
  const originals = new Map<string, string | undefined>();
  const original = (fileName: string) => {
    if (!originals.has(fileName)) originals.set(fileName, host.readFile(fileName));
    return originals.get(fileName);
  };

  const files: SourceFiles = { plain: new Map(), seam: cache?.seam ?? new WeakMap() };

  // Pass 1: plain transform.
  const first = new Map<string, TransformResult>();
  const host1 = seamHost(
    host,
    files,
    (f) => {
      if (!first.has(f)) {
        const source = original(f);
        if (source === undefined) return undefined;
        first.set(f, transformCached(source, f, undefined));
      }
      return first.get(f);
    },
    cache,
  );
  const program1 = ts.createProgram(rootNames, options, host1);

  const wraps = new Map<string, UnknownWrap[]>();
  const pending: Diagnostic[] = [];
  for (const [fileName, r] of first) {
    const sf = program1.getSourceFile(fileName);
    if (r.syntaxError || sf === undefined) continue;
    const { sites, findings } = findSources(program1, sf);
    const map = new TraceMap(r.map as unknown as ConstructorParameters<typeof TraceMap>[0]);
    pending.push(...findings.filter((f) => !f.fixOnly).map((f) => fromFinding(f, fileName, sf, map)));
    const source = original(fileName)!;
    const mapped = sites.flatMap((site) => {
      const start = originalOffset(map, sf, source, site.start);
      const last = originalOffset(map, sf, source, site.end - 1);
      return start === undefined || last === undefined ? [] : [{ start, end: last + 1, async: site.async, ...(site.each ? { each: true as const } : {}) }];
    });
    if (mapped.length > 0) wraps.set(fileName, mapped);
  }

  // Pass 2: files with sources are transformed again with their wraps. Without
  // any, the first program is already the final one.
  const outputs = new Map<string, TransformResult>(wraps.size === 0 ? first : []);
  const host2 = seamHost(
    host,
    files,
    (f) => {
      if (!outputs.has(f)) {
        const w = wraps.get(f);
        const reuse = first.get(f);
        if (w === undefined && reuse !== undefined) outputs.set(f, reuse);
        else {
          const source = original(f);
          if (source === undefined) return undefined;
          outputs.set(f, transformCached(source, f, w));
        }
      }
      return outputs.get(f);
    },
    cache,
  );
  const program = wraps.size === 0 ? program1 : ts.createProgram(rootNames, options, host2, program1);
  const finalHost = wraps.size === 0 ? host1 : host2;

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
        const runtime = ts.resolveModuleName(RUNTIME_MODULE, fileName, options, finalHost).resolvedModule?.resolvedFileName;
        for (const f of checkFlows(program, sf, runtime)) if (!f.fixOnly) out.push(fromFinding(f, fileName, sf, mapOf(fileName, r)));
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
