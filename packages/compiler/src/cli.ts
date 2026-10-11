// seamc: check a project, emit plain TypeScript, or print one file's output.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { type Diagnostic, formatDiagnostic } from "./diagnostics.js";
import { createSeamProgram, defaultCompilerOptions } from "./program.js";
import { isSeamFile, transform } from "./transform.js";

const USAGE = `Usage:
  seamc check [-p tsconfig.json] [files...]      Type-check, including SeamScript's boundary rules
  seamc build [-p tsconfig.json] --outDir <dir>  Check, then write each .seam.ts as plain TypeScript
  seamc transform <file.seam.ts>                 Print the plain TypeScript for one file`;

type Args = { command: string; project?: string; outDir?: string; files: string[] };

function parseArgs(argv: string[]): Args | string {
  const [command, ...rest] = argv;
  if (!command || !["check", "build", "transform"].includes(command)) return USAGE;
  const args: Args = { command, files: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-p" || a === "--project") args.project = rest[++i];
    else if (a === "--outDir") args.outDir = rest[++i];
    else if (a.startsWith("-")) return `Unknown option ${a}\n\n${USAGE}`;
    else args.files.push(a);
  }
  if (args.command === "build" && !args.outDir) return `build needs --outDir\n\n${USAGE}`;
  if (args.command === "transform" && args.files.length !== 1) return `transform takes one file\n\n${USAGE}`;
  return args;
}

/** Root files and options from a tsconfig.json, or the given files with strict defaults. */
function loadProject(args: Args): { rootNames: string[]; options: ts.CompilerOptions; configErrors: readonly ts.Diagnostic[] } {
  const configPath = args.project
    ? resolve(args.project)
    : args.files.length === 0
      ? ts.findConfigFile(process.cwd(), ts.sys.fileExists)
      : undefined;
  if (configPath === undefined) {
    return { rootNames: args.files.map((f) => resolve(f)), options: defaultCompilerOptions, configErrors: [] };
  }
  const configErrors: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => configErrors.push(d),
  });
  if (parsed === undefined) return { rootNames: [], options: {}, configErrors };
  return {
    rootNames: args.files.length > 0 ? args.files.map((f) => resolve(f)) : parsed.fileNames,
    options: parsed.options,
    configErrors: [...configErrors, ...parsed.errors],
  };
}

function print(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    console.error(formatDiagnostic({ ...d, file: d.file && relative(process.cwd(), d.file) }));
  }
  const errors = diagnostics.filter((d) => d.category === "error").length;
  if (errors > 0) console.error(`\nFound ${errors} error${errors === 1 ? "" : "s"}.`);
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }

  if (args.command === "transform") {
    const file = resolve(args.files[0]!);
    const r = transform(readFileSync(file, "utf8"), file);
    if (r.diagnostics.length > 0) {
      print(r.diagnostics);
      return 1;
    }
    process.stdout.write(r.code);
    return 0;
  }

  const { rootNames, options, configErrors } = loadProject(args);
  if (configErrors.length > 0) {
    console.error(ts.formatDiagnostics(configErrors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
    return 2;
  }
  const p = createSeamProgram(rootNames, options);
  const diagnostics = p.diagnostics();
  print(diagnostics);
  if (diagnostics.some((d) => d.category === "error")) return 1;

  if (args.command === "build") {
    // Output keeps each file's name, so imports like "./order.seam" still resolve.
    const root = options.rootDir ? resolve(options.rootDir) : commonDir([...p.outputs.keys()]);
    for (const [file, r] of p.outputs) {
      if (!isSeamFile(file)) continue;
      const out = join(resolve(args.outDir!), relative(root, file));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, r.code);
    }
  }
  return 0;
}

function commonDir(files: string[]): string {
  if (files.length === 0) return process.cwd();
  let dir = dirname(files[0]!);
  while (!files.every((f) => f.startsWith(dir + "/"))) dir = dirname(dir);
  return dir;
}
