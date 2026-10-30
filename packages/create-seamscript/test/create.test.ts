import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript, no declarations
import { create, packageName, parseArgs, seamSpec } from "../index.js";

// Apps are created inside the repository so that @seamscript/* resolve through
// the workspace's node_modules, as they would from npm after `npm install`.
const TMP = new URL("./.tmp/", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const seamc = join(repo, "packages/compiler/bin/seamc.js");
const vite = join(repo, "node_modules/vite/bin/vite.js");

describe("arguments", () => {
  it("takes a directory and a template", () => {
    expect(parseArgs(["my-app", "--template", "vanilla"])).toEqual({ directory: "my-app", template: "vanilla", help: false });
    expect(parseArgs(["--template=react"])).toEqual({ directory: undefined, template: "react", help: false });
    expect(parseArgs(["-t", "svelte"])).toMatch(/Unknown template svelte/);
    expect(parseArgs(["a", "b"])).toMatch(/Unexpected argument b/);
  });

  it("makes a package name from the directory", () => {
    expect(packageName("/x/My App!")).toBe("my-app");
    expect(packageName("./.hidden")).toBe("hidden");
  });

  it("refuses a directory that is not empty", () => {
    const dir = join(TMP, "taken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x"), "");
    expect(() => create(dir, "react")).toThrow(/not empty/);
  });
});

describe("where the packages come from", () => {
  it("is npm by version, or a release's tarballs when the scaffold was packed for one", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(seamSpec("@seamscript/runtime", undefined)).toBe(version);
    expect(seamSpec("@seamscript/ts-plugin", { base: "https://example.test/v1/" })).toBe(`https://example.test/v1/seamscript-ts-plugin-${version}.tgz`);
  });
});

describe("the sample data", () => {
  it("decodes people 1 and 2, and shows a DecodeError for 3", async () => {
    const dir = join(TMP, "data");
    create(dir, "vanilla");
    const { transform } = await import(join(repo, "packages/compiler/dist/transform.js"));
    const out = join(dir, "src/people.gen.ts");
    writeFileSync(out, transform(readFileSync(join(dir, "src/people.seam.ts"), "utf8"), join(dir, "src/people.seam.ts")).code);
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(readFileSync(join(dir, "public", url), "utf8"))) as typeof fetch;
    try {
      const { loadPerson, describeProblem } = await import(out);
      const [one, two, three] = [await loadPerson(1), await loadPerson(2), await loadPerson(3)];
      expect(one).toMatchObject({ ok: true, value: { id: 1n, balance: "1250.5" } });
      expect(two).toMatchObject({ ok: true, value: { id: 9007199254740993n } });
      expect(three.ok).toBe(false);
      expect(describeProblem(three.error)).toBe("Unexpected data at name: expected text of length 1..80, got length 0.");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe.each(["react", "vanilla"])("the %s template", (template) => {
  const dir = join(TMP, template);

  it("writes a complete app", () => {
    create(dir, template);
    const files = readdirSync(dir, { recursive: true }).map(String).sort();
    expect(files).toEqual(expect.arrayContaining([".gitignore", "README.md", "index.html", "package.json", "public/people/1.json", "src/people.seam.ts", "tsconfig.json", "vite.config.ts"]));
    expect(files).not.toContain("_gitignore");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe(template);
    expect(Object.keys(pkg.dependencies)).toContain("@seamscript/runtime");
    expect("@seamscript/react" in pkg.dependencies).toBe(template === "react");
  });

  it("passes seamc check", () => {
    expect(() => execFileSync(process.execPath, [seamc, "check", "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" })).not.toThrow();
  });

  it("builds with Vite, with the WASM core in the bundle", () => {
    execFileSync(process.execPath, [vite, "build", "--logLevel", "error"], { cwd: dir, stdio: "pipe" });
    const assets = join(dir, "dist/assets");
    const js = readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
    // The base64 of the WASM magic number.
    expect(js).toContain("AGFzbQ");
    expect(existsSync(join(dir, "dist/people/3.json"))).toBe(true);
  }, 60_000);
});
