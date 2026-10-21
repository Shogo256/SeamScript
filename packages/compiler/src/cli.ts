// seamc: check a project, emit plain TypeScript, or print one file's output.
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
// Loaded with require: importing TypeScript's CommonJS API as ESM makes Node
// scan all of it for export names first, about 100 ms on every run.
import ts = require("typescript");
import { readSeamConfig, type SeamConfig } from "./config.js";
import { type Diagnostic, formatDiagnostic } from "./diagnostics.js";
import { createSeamCache, createSeamProgram, defaultCompilerOptions, type SeamCache } from "./program.js";
import { isSeamFile, transform } from "./transform.js";

const USAGE = `Usage:
  seamc check [-p tsconfig.json] [-w] [files...]  Type-check, including SeamScript's boundary rules
  seamc build [-p tsconfig.json] --outDir <dir> [--production [--defer-core]] [-w]
                                                 Check, then write each .seam.ts as plain TypeScript;
                                                 --production also imports @seamscript/core (WASM)
                                                 into the files that use Text; --defer-core loads it
                                                 without holding up start-up (await Text.ready)
  seamc transform <file.seam.ts>                 Print the plain TypeScript for one file

  -w, --watch   Check again (and build) whenever a source file or tsconfig.json changes
  -h, --help    Show this help
  -v, --version Show the version`;

// The line under the name is a seam: stitches, with the "p" hanging through it.
const LOGO = [
  "   _____                     _____           _       __",
  "  / ___/___  ____ _____ ___ / ___/__________(_)___  / /_",
  "  \\__ \\/ _ \\/ __ `/ __ `__ \\\\__ \\/ ___/ ___/ / __ \\/ __/",
  " ___/ /  __/ /_/ / / / / / /__/ / /__/ /  / / /_/ / /_",
  "/____/\\___/\\__,_/_/ /_/ /_/____/\\___/_/  /_/ .___/\\__/",
  "- - - - - - - - - - - - - - - - - - - - - /_/ - - - - -",
].join("\n");

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return `seamc ${pkg.version} (TypeScript ${ts.version})`;
}

/**
 * What `--help` and `--version` print. The logo only goes to a terminal, so
 * scripts that read the version and CI logs get plain text.
 */
export function about(what: "help" | "version", terminal: boolean): string {
  const head = terminal ? `${LOGO}\n\n` : "";
  if (what === "version") return `${head}${version()}`;
  return `${head}${version()}\nTypeScript where data from outside your program can't be used until it's checked.\n\n${USAGE}`;
}

type Args = { command: string; project?: string; outDir?: string; production?: boolean; deferCore?: boolean; watch?: boolean; files: string[] };

function parseArgs(argv: string[]): Args | string {
  const [command, ...rest] = argv;
  if (command === undefined || ["help", "-h", "--help"].includes(command)) return { command: "help", files: [] };
  if (["version", "-v", "--version"].includes(command)) return { command: "version", files: [] };
  if (!["check", "build", "transform"].includes(command)) return `Unknown command ${command}\n\n${USAGE}`;
  const args: Args = { command, files: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-p" || a === "--project") args.project = rest[++i];
    else if (a === "--outDir") args.outDir = rest[++i];
    else if (a === "--production") args.production = true;
    else if (a === "--defer-core") args.deferCore = true;
    else if ((a === "-w" || a === "--watch") && command !== "transform") args.watch = true;
    else if (a.startsWith("-")) return `Unknown option ${a}\n\n${USAGE}`;
    else args.files.push(a);
  }
  if (args.command === "build" && !args.outDir) return `build needs --outDir\n\n${USAGE}`;
  if (args.deferCore && !args.production) return `--defer-core goes with --production\n\n${USAGE}`;
  if (args.command === "transform" && args.files.length !== 1) return `transform takes one file\n\n${USAGE}`;
  return args;
}

interface Project {
  rootNames: string[];
  options: ts.CompilerOptions;
  seam: SeamConfig;
  configErrors: readonly ts.Diagnostic[];
  /** What a watch watches: the directories the project's files come from, and the config file's. */
  directories: string[];
}

/** Root files and options from a tsconfig.json, or the given files with strict defaults. */
function loadProject(args: Args): Project {
  const configPath = args.project
    ? resolve(args.project)
    : args.files.length === 0
      ? ts.findConfigFile(process.cwd(), ts.sys.fileExists)
      : undefined;
  const fileDirs = args.files.map((f) => dirname(resolve(f)));
  if (configPath === undefined) {
    return { rootNames: args.files.map((f) => resolve(f)), options: defaultCompilerOptions, seam: {}, configErrors: [], directories: fileDirs };
  }
  const configErrors: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => configErrors.push(d),
  });
  if (parsed === undefined) return { rootNames: [], options: {}, seam: {}, configErrors, directories: [dirname(configPath)] };
  const seam = readSeamConfig((parsed.raw as { seamscript?: unknown } | undefined)?.seamscript);
  const seamErrors = seam.errors.map((messageText): ts.Diagnostic => ({ category: ts.DiagnosticCategory.Error, code: 0, file: undefined, start: undefined, length: undefined, messageText: `${configPath}: ${messageText}` }));
  return {
    rootNames: args.files.length > 0 ? args.files.map((f) => resolve(f)) : parsed.fileNames,
    options: parsed.options,
    seam: seam.config,
    configErrors: [...configErrors, ...parsed.errors, ...seamErrors],
    directories: [dirname(configPath), ...Object.keys(parsed.wildcardDirectories ?? {}), ...fileDirs],
  };
}

function print(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    console.error(formatDiagnostic({ ...d, file: d.file && relative(process.cwd(), d.file) }));
  }
}

const plural = (n: number) => `${n} error${n === 1 ? "" : "s"}`;

/** Checks (and builds) once; returns the number of errors, or -1 when the configuration is unusable. */
function run(args: Args, project: Project, cache?: SeamCache): number {
  const { rootNames, options, configErrors } = project;
  if (configErrors.length > 0) {
    console.error(ts.formatDiagnostics(configErrors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
    return -1;
  }
  const p = createSeamProgram(rootNames, options, undefined, { production: args.production, deferCore: args.deferCore, cache, checker: project.seam });
  const diagnostics = p.diagnostics();
  print(diagnostics);
  const errors = diagnostics.filter((d) => d.category === "error").length;
  if (errors > 0 || args.command !== "build") return errors;
  // Output keeps each file's name, so imports like "./order.seam" still resolve.
  const root = options.rootDir ? resolve(options.rootDir) : commonDir([...p.outputs.keys()]);
  for (const [file, r] of p.outputs) {
    if (!isSeamFile(file)) continue;
    const out = join(resolve(args.outDir!), relative(root, file));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.code);
  }
  return 0;
}

/**
 * Checks once, then again after each change to a source file or the
 * configuration (debounced). Files whose text did not change are neither parsed
 * nor transformed again; the type check itself runs on the whole program.
 */
function watchProject(args: Args): number {
  const time = () => new Date().toLocaleTimeString();
  const outDir = args.outDir === undefined ? undefined : resolve(args.outDir);
  let cache = createSeamCache();
  let lastOptions = "";
  const watched = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = (reason: string) => {
    const started = performance.now();
    console.error(`[${time()}] ${reason}`);
    const project = loadProject(args);
    // Watch before checking: a file saved while the check runs is then checked
    // again right after it, instead of being missed.
    for (const dir of project.directories) if (!watched.has(dir)) listen(dir);
    const optionsKey = JSON.stringify([project.options, project.seam]);
    if (optionsKey !== lastOptions) {
      cache = createSeamCache();
      lastOptions = optionsKey;
    }
    const errors = run(args, project, cache);
    const result = errors < 0 ? "The configuration has errors" : `Found ${plural(errors)}`;
    console.error(`[${time()}] ${result} (${Math.round(performance.now() - started)} ms). Watching for file changes.`);
  };

  const listen = (dir: string) => {
    watched.add(dir);
    watch(dir, { recursive: true }, (_event, name) => {
      if (name === null || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(name) || !/\.(?:[cm]?[jt]sx?|json)$/.test(name)) return;
      if (outDir !== undefined && resolve(dir, name).startsWith(outDir + "/")) return;
      clearTimeout(timer);
      timer = setTimeout(() => check("File change detected. Checking again..."), 100);
    });
  };

  check("Starting a check in watch mode...");
  return 0;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }

  if (args.command === "help" || args.command === "version") {
    console.log(about(args.command, process.stdout.isTTY === true));
    return 0;
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

  if (args.watch) return watchProject(args);
  const errors = run(args, loadProject(args));
  if (errors < 0) return 2;
  if (errors > 0) console.error(`\nFound ${plural(errors)}.`);
  return errors > 0 ? 1 : 0;
}

function commonDir(files: string[]): string {
  if (files.length === 0) return process.cwd();
  let dir = dirname(files[0]!);
  while (!files.every((f) => f.startsWith(dir + "/"))) dir = dirname(dir);
  return dir;
}
