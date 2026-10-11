// Differential test against the published @babel/parser at the same version, over
// every input in upstream's fixture suite (scripts/fetch-fixtures.sh):
//
// Every fixture runs twice, with and without `errorRecovery`, so error fixtures
// compare their recovered ASTs too.
//
//  1. Without the seamscript plugin the fork must behave exactly like upstream:
//     same AST, same recovered errors, or the same thrown error. This checks that
//     the fork's build (scripts/build.mjs) reproduces upstream's.
//  2. With the seamscript plugin added, every TypeScript fixture must still parse
//     exactly as upstream parses it without the plugin. This is the superset
//     property: SeamScript syntax never changes the meaning of valid (or invalid) TS.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as upstreamParse } from "@babel/parser";
import { parse as forkParse } from "@seamscript/parser";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../.fixtures/packages/babel-parser/test/fixtures", import.meta.url).pathname;

type Options = Record<string, unknown> & { plugins?: unknown[] };

// Keys the fixture runner reads; they are not parser options.
const TEST_ONLY = new Set(["throws", "BABEL_8_BREAKING", "SKIP_babel7plugins_babel8core", "minNodeVersion"]);

const pluginName = (p: unknown) => (Array.isArray(p) ? p[0] : p) as string;

function mergeOptions(base: Options, extra: Options): Options {
  const out: Options = { ...base, ...extra };
  if (base.plugins && extra.plugins) {
    const byName = new Map<string, unknown>();
    for (const p of [...base.plugins, ...extra.plugins]) byName.set(pluginName(p), p);
    out.plugins = [...byName.values()];
  }
  return out;
}

type Fixture = { file: string; options: Options };

function collect(dir: string, inherited: Options, out: Fixture[]): void {
  let options = inherited;
  const optionsFile = join(dir, "options.json");
  if (existsSync(optionsFile)) options = mergeOptions(options, JSON.parse(readFileSync(optionsFile, "utf8")));
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path, options, out);
    else if (/^input\.[cm]?[jt]sx?$/.test(entry)) out.push({ file: path, options });
  }
}

function parserOptions(o: Options): Options {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !TEST_ONLY.has(k)));
}

function outcome(parse: (src: string, opts: object) => unknown, source: string, options: Options): string {
  try {
    return JSON.stringify(parse(source, options), (_key, value) => {
      if (typeof value === "bigint") return `${value}n`;
      if (value instanceof Error) return { message: value.message, ...value };
      return value;
    });
  } catch (e) {
    return `THROWS ${(e as Error).message}`;
  }
}

const fixtures: Fixture[] = [];
collect(ROOT, {}, fixtures);

describe("fork vs upstream @babel/parser 8.0.7", () => {
  it("found the upstream fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(5000);
  });

  it("is identical without the seamscript plugin", () => {
    const mismatches: string[] = [];
    for (const { file, options } of fixtures) {
      const source = readFileSync(file, "utf8");
      for (const errorRecovery of [false, true]) {
        const opts = { ...parserOptions(options), errorRecovery };
        if (outcome(upstreamParse, source, opts) !== outcome(forkParse, source, opts)) {
          mismatches.push(`${file.slice(ROOT.length + 1)} (errorRecovery: ${errorRecovery})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("parses every TypeScript fixture identically with the seamscript plugin", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const { file, options } of fixtures) {
      const plugins = options.plugins ?? [];
      if (!plugins.some((p) => pluginName(p) === "typescript")) continue;
      checked++;
      const source = readFileSync(file, "utf8");
      for (const errorRecovery of [false, true]) {
        const opts = { ...parserOptions(options), errorRecovery };
        const expected = outcome(upstreamParse, source, opts);
        const actual = outcome(forkParse, source, { ...opts, plugins: [...plugins, "seamscript"] });
        if (expected !== actual) mismatches.push(`${file.slice(ROOT.length + 1)} (errorRecovery: ${errorRecovery})`);
      }
    }
    expect(checked).toBeGreaterThan(600);
    expect(mismatches).toEqual([]);
  });
});
