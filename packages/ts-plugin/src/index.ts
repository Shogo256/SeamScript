// A TypeScript language service plugin (a tsserver plugin) for SeamScript.
//
// tsserver sees each .seam.ts file as the plain TypeScript the compiler emits,
// and Volar maps positions both ways, so completion, hover, navigation, rename
// and TypeScript's own errors work as in any TypeScript file. SeamScript's
// diagnostics are added: the transform's (SEAM1xxx) and the checker pass's
// (SEAM2xxx), which runs on the language service's own program.
//
// The checker pass needs the second build of the command line, where outside
// data is wrapped in `__unknown(...)`. Here the wraps are part of the virtual
// code: after each check, the sites found in the current program are compared
// with the wraps the code was made with, and when they differ the code is made
// again and the check repeated. The wrapped program finds the same sites, so this
// settles after one round.
import { createChecker, type Finding } from "@seamscript/compiler/checker";
import { readSeamConfig } from "@seamscript/compiler/config";
import { isSeamFile, RUNTIME_MODULE, type UnknownWrap } from "@seamscript/compiler/transform";
import type { Language, LanguagePlugin } from "@volar/language-core";
import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin.js";
import type * as ts from "typescript";
import { createSeamCode, diff, type SeamCode, shiftWraps, toSource, toSourceExact } from "./code.js";

const plugin = createLanguageServicePlugin((tsModule, info) => {
  // The project's "seamscript" settings in tsconfig.json, read when tsserver loads
  // the plugin (seamc check reports mistakes in them).
  const project = info.project as ts.server.Project & { getConfigFilePath?: () => string };
  const configPath = project.getConfigFilePath?.();
  const raw = configPath === undefined ? undefined : (tsModule.readConfigFile(configPath, tsModule.sys.readFile).config as { seamscript?: unknown } | undefined);
  const checker = createChecker(tsModule, readSeamConfig(raw?.seamscript).config);
  // Volar replaces info.languageService with a proxy that maps positions; this
  // one works on the virtual code, which is what the checker pass needs.
  const service = info.languageService;
  const host = info.languageServiceHost;
  const wraps = new Map<string, readonly UnknownWrap[]>();

  // A file whose wraps changed gets a new version, so that both TypeScript and
  // Volar ask for its code again although its text did not change.
  const generations = new Map<string, number>();
  const getScriptVersion = host.getScriptVersion.bind(host);
  host.getScriptVersion = (fileName) => {
    const g = generations.get(fileName);
    return g === undefined ? getScriptVersion(fileName) : `${getScriptVersion(fileName)}+seam${g}`;
  };

  const seam: LanguagePlugin<string, SeamCode> = {
    getLanguageId: (fileName) => (isSeamFile(fileName) ? "seamscript" : undefined),
    createVirtualCode: (fileName, languageId, snapshot) =>
      languageId === "seamscript" ? createSeamCode(fileName, snapshot, wraps.get(fileName) ?? []) : undefined,
    updateVirtualCode: (fileName, previous, snapshot) => {
      const e = diff(previous.source, snapshot.getText(0, snapshot.getLength()));
      const w = e === undefined ? (wraps.get(fileName) ?? []) : shiftWraps(wraps.get(fileName) ?? [], e);
      wraps.set(fileName, w);
      return createSeamCode(fileName, snapshot, w, previous);
    },
    typescript: {
      extraFileExtensions: [],
      getServiceScript: (root) => {
        const tsx = (root as SeamCode).fileName.endsWith(".tsx");
        // Without preventLeadingOffset, Volar puts the virtual code after blank
        // lines shaped like the source, so a source offset has the same line and
        // column in the text tsserver converts positions with.
        return { code: root, extension: tsx ? ".tsx" : ".ts", scriptKind: tsx ? tsModule.ScriptKind.TSX : tsModule.ScriptKind.TS };
      },
    },
  };

  return {
    languagePlugins: [seam],
    setup(language: Language<string>) {
      const proxy = info.languageService;
      const codeOf = (fileName: string) => {
        const root = language.scripts.get(fileName)?.generated?.root;
        return root !== undefined && "state" in root ? (root as SeamCode) : undefined;
      };

      const diagnostic = (file: ts.SourceFile | undefined, start: number, length: number, code: string, message: string): ts.Diagnostic => ({
        file,
        start,
        length: Math.max(length, 1),
        messageText: message,
        category: tsModule.DiagnosticCategory.Error,
        code: Number(code.replace(/^\D+/, "")),
        source: "seamscript",
      });

      /** The transform's diagnostics, which carry a line and column. */
      const fromTransform = (code: SeamCode, file: ts.SourceFile | undefined, syntax: boolean) => {
        const lineStarts = [0];
        for (let i = code.source.indexOf("\n"); i >= 0; i = code.source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
        return code.diagnostics
          .filter((d) => (d.code === "SEAM1000") === syntax)
          .map((d) => {
            const start = (lineStarts[d.line - 1] ?? 0) + d.column - 1;
            const word = /^[\w$]+/.exec(code.source.slice(start, start + 200));
            return diagnostic(file, start, word?.[0].length ?? 1, d.code, d.message);
          });
      };

      /** Quick fixes of the last check, per file, in source positions. */
      const fixes = new Map<string, { start: number; end: number; code: number; fix: { description: string; changes: ts.TextChange[] } }[]>();

      const fromFinding = (code: SeamCode, file: ts.SourceFile | undefined, f: Finding) => {
        const start = toSource(code, f.pos);
        const end = toSource(code, Math.max(f.pos, f.end - 1)) + 1;
        const d = diagnostic(file, start, end - start, f.code, f.message);
        if (f.fix !== undefined) {
          // Every edit must land in text kept from the source, or the fix is not offered.
          const changes = f.fix.edits.map((e) => {
            const from = toSourceExact(code, e.pos);
            const to = e.end > e.pos ? toSourceExact(code, e.end - 1) : from;
            return from === undefined || to === undefined ? undefined : { span: { start: from, length: e.end > e.pos ? to + 1 - from : 0 }, newText: e.text };
          });
          if (changes.every((c) => c !== undefined)) fixes.get(code.fileName)?.push({ start, end, code: d.code, fix: { description: f.fix.description, changes } });
        }
        return d;
      };

      const runtimeOf = (fileName: string) =>
        tsModule.resolveModuleName(RUNTIME_MODULE, fileName, info.project.getCompilerOptions(), tsModule.sys).resolvedModule?.resolvedFileName;

      const sameWraps = (a: readonly UnknownWrap[], b: readonly UnknownWrap[]) =>
        a.length === b.length && a.every((w, i) => w.start === b[i]!.start && w.end === b[i]!.end && w.async === b[i]!.async && w.each === b[i]!.each);

      function semantic(fileName: string, round = 0): ts.Diagnostic[] {
        // First, as it brings the program and the file's virtual code up to date.
        const base = proxy.getSemanticDiagnostics(fileName);
        const code = isSeamFile(fileName) ? codeOf(fileName) : undefined;
        if (code === undefined || code.state === "patched") return base;
        // The unparsed source of a file that never transformed has no meaningful types.
        if (code.state === "raw") return [];
        const program = service.getProgram();
        const file = program?.getSourceFile(fileName);
        if (program === undefined || file === undefined) return base;

        // The program's text is the blank lines (as long as the source), then the code.
        const lead = code.source.length;
        const { sites, findings } = checker.findSources(program, file);
        const found = sites.flatMap((s) => {
          const start = toSourceExact(code, s.start - lead);
          const last = toSourceExact(code, s.end - 1 - lead);
          return start === undefined || last === undefined ? [] : [{ start, end: last + 1, async: s.async, ...(s.each ? { each: true as const } : {}) }];
        });
        found.sort((a, b) => a.start - b.start || a.end - b.end);
        if (!sameWraps(found, code.wraps) && round === 0) {
          wraps.set(fileName, found);
          generations.set(fileName, (generations.get(fileName) ?? 0) + 1);
          const script = language.scripts.get(fileName);
          if (script !== undefined) script.isAssociationDirty = true;
          // tsserver's language service compares file versions only once the
          // project's own version has moved.
          info.project.getScriptInfo(fileName)?.markContainingProjectsAsDirty();
          return semantic(fileName, round + 1);
        }
        fixes.set(fileName, []);
        return [
          ...base,
          ...fromTransform(code, file, false),
          ...[...findings, ...checker.checkFlows(program, file, runtimeOf(fileName))].flatMap((f) => {
            const shifted = { ...f, pos: f.pos - lead, end: f.end - lead, ...(f.fix ? { fix: { ...f.fix, edits: f.fix.edits.map((e) => ({ ...e, pos: e.pos - lead, end: e.end - lead })) } } : {}) };
            const d = fromFinding(code, file, shifted);
            return f.fixOnly ? [] : [d];
          }),
        ];
      }

      function syntactic(fileName: string): ts.DiagnosticWithLocation[] {
        const base = proxy.getSyntacticDiagnostics(fileName);
        const code = isSeamFile(fileName) ? codeOf(fileName) : undefined;
        if (code === undefined) return base;
        const file = service.getProgram()?.getSourceFile(fileName);
        // TypeScript's errors on unparsed SeamScript syntax would only be noise.
        if (code.state === "raw") return fromTransform(code, file, true) as ts.DiagnosticWithLocation[];
        // While typing, TypeScript usually reports the same error; SeamScript's own
        // syntax errors (a malformed decode, say) are the ones it does not see.
        if (code.state === "patched" && base.length === 0) return fromTransform(code, file, true) as ts.DiagnosticWithLocation[];
        return base;
      }

      // TypeScript's errors for Unknown assigned to a typed variable carry the decode
      // fix: TS2322, or TS2739/2740/2741 when the type is an object (a boundary).
      const ASSIGNMENT = [2322, 2739, 2740, 2741];
      const FIXABLE = ["2001", "2005", "2101", "2201", "1402", ...ASSIGNMENT.map(String)];
      const matches = (code: number, errorCodes: readonly number[]) =>
        errorCodes.includes(code) || (code === 2322 && errorCodes.some((c) => ASSIGNMENT.includes(c)));

      function codeFixes(fileName: string, start: number, end: number, errorCodes: readonly number[], ...rest: unknown[]): readonly ts.CodeFixAction[] {
        const base = (proxy.getCodeFixesAtPosition as (...a: unknown[]) => readonly ts.CodeFixAction[])(fileName, start, end, errorCodes, ...rest);
        const ours = (fixes.get(fileName) ?? [])
          .filter((f) => matches(f.code, errorCodes) && f.start <= end && start <= f.end)
          .map((f): ts.CodeFixAction => ({ fixName: "seamscript", description: f.fix.description, changes: [{ fileName, textChanges: f.fix.changes }] }));
        return [...ours, ...base];
      }

      info.languageService = new Proxy(proxy, {
        get(target, key) {
          if (key === "getSemanticDiagnostics") return (fileName: string) => semantic(fileName);
          if (key === "getSyntacticDiagnostics") return syntactic;
          if (key === "getCodeFixesAtPosition") return codeFixes;
          // An editor asks for fixes only for the codes listed here.
          if (key === "getSupportedCodeFixes") return (fileName?: string) => [...proxy.getSupportedCodeFixes(fileName), ...FIXABLE];
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

export default plugin;
