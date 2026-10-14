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
import { isSeamFile, RUNTIME_MODULE, type UnknownWrap } from "@seamscript/compiler/transform";
import type { Language, LanguagePlugin } from "@volar/language-core";
import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin.js";
import type * as ts from "typescript";
import { createSeamCode, diff, type SeamCode, shiftWraps, toSource, toSourceExact } from "./code.js";

const plugin = createLanguageServicePlugin((tsModule, info) => {
  const checker = createChecker(tsModule);
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

      const fromFinding = (code: SeamCode, file: ts.SourceFile | undefined, f: Finding) => {
        const start = toSource(code, f.pos);
        const end = toSource(code, Math.max(f.pos, f.end - 1)) + 1;
        return diagnostic(file, start, end - start, f.code, f.message);
      };

      const runtimeOf = (fileName: string) =>
        tsModule.resolveModuleName(RUNTIME_MODULE, fileName, info.project.getCompilerOptions(), tsModule.sys).resolvedModule?.resolvedFileName;

      const sameWraps = (a: readonly UnknownWrap[], b: readonly UnknownWrap[]) =>
        a.length === b.length && a.every((w, i) => w.start === b[i]!.start && w.end === b[i]!.end && w.async === b[i]!.async);

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
          return start === undefined || last === undefined ? [] : [{ start, end: last + 1, async: s.async }];
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
        return [
          ...base,
          ...fromTransform(code, file, false),
          ...[...findings, ...checker.checkFlows(program, file, runtimeOf(fileName))].map((f) =>
            fromFinding(code, file, { ...f, pos: f.pos - lead, end: f.end - lead }),
          ),
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

      info.languageService = new Proxy(proxy, {
        get(target, key) {
          if (key === "getSemanticDiagnostics") return (fileName: string) => semantic(fileName);
          if (key === "getSyntacticDiagnostics") return syntactic;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

export default plugin;
