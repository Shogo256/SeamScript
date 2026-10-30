// The warning about the editor's TypeScript differing from the one seamc checks with.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { typescriptMismatch } from "../src/version.js";

describe("typescriptMismatch", () => {
  it("says nothing when the major and minor versions match, whatever the patch", () => {
    expect(typescriptMismatch("5.9.3", "5.9.3")).toBeUndefined();
    expect(typescriptMismatch("5.9.2", "5.9.3")).toBeUndefined();
    expect(typescriptMismatch("5.9.4-dev.20261020", "5.9.3")).toBeUndefined();
  });

  it("warns when they differ, naming both and how to switch", () => {
    expect(typescriptMismatch("5.8.2", "5.9.3")).toBe(
      "This editor runs TypeScript 5.8.2, but seamc checks with TypeScript 5.9.3, so the type errors shown here can differ from `seamc check`. " +
        'Have the editor use the workspace\'s TypeScript 5.9 (in VS Code: "TypeScript: Select TypeScript Version").',
    );
    expect(typescriptMismatch("6.0.0-beta", "5.9.3")).toMatch(/^This editor runs TypeScript 6\.0\.0-beta/);
  });

  it("says nothing when a version can't be read", () => {
    expect(typescriptMismatch("unknown", "5.9.3")).toBeUndefined();
  });
});

it("the built plugin carries the TypeScript version seamc pins", () => {
  const pinned = JSON.parse(readFileSync(new URL("../../compiler/package.json", import.meta.url), "utf8")).dependencies.typescript;
  const bundle = readFileSync(new URL("../dist/index.cjs", import.meta.url), "utf8");
  expect(bundle).not.toContain("__SEAMC_TYPESCRIPT__");
  // esbuild folds the typeof check: `SEAMC_TYPESCRIPT = true ? "5.9.3" : "unknown"`.
  expect(/SEAMC_TYPESCRIPT = [^;]*?"([^"]+)"/.exec(bundle)?.[1]).toBe(pinned);
});
