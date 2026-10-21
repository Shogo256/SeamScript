// What the bundler plugins add for the WASM core besides the .seam.ts transform:
// a plain JavaScript or TypeScript module that uses Text from
// @seamscript/runtime (a helper module, a shared package) needs the core loaded
// too, or it would run on the host's ICU in production.
import MagicString from "magic-string";
import { CORE_MODULE, DEFERRED_CORE_MODULE } from "./transform.js";

const SCRIPT = /\.[cm]?[jt]sx?$/;
// Leading hashbang and directives ("use client"), which must stay first.
const PROLOGUE = /^(?:#![^\n]*\n)?(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)|\s*(["'])use [^"'\n]+\1;?)*/;

/** Adds the core import to a plain module that uses Text at run time; null when there is nothing to do. */
export function addCoreImport(code: string, file: string, deferred: boolean): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!SCRIPT.test(file) || /[\\/]@?seamscript[\\/]/.test(file) || /[\\/]packages[\\/](?:runtime|core)[\\/]/.test(file)) return null;
  if (!code.includes("@seamscript/runtime") || !/\bText\s*[.[]/.test(code)) return null;
  const s = new MagicString(code);
  s.appendLeft(PROLOGUE.exec(code)![0].length, `\nimport "${deferred ? DEFERRED_CORE_MODULE : CORE_MODULE}";\n`);
  return { code: s.toString(), map: s.generateMap({ source: file, hires: true, includeContent: true }) };
}
