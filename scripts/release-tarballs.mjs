// Packs every published package into release/v<version>/, for a GitHub release:
// the scaffold in it writes those tarballs as the new app's dependencies, so
//   npx <base>/create-seamscript-<version>.tgz my-app
// works without the npm registry. Run after `yarn build`.
//
//   node scripts/release-tarballs.mjs [--base <url ending in />]
// The base defaults to this version's GitHub release download URL.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const PACKAGES = ["runtime", "core", "parser", "compiler", "react", "ts-plugin", "create-seamscript"];

const { version } = JSON.parse(readFileSync(join(root, "packages/create-seamscript/package.json"), "utf8"));
for (const p of PACKAGES) {
  const v = JSON.parse(readFileSync(join(root, "packages", p, "package.json"), "utf8")).version;
  if (v !== version) throw new Error(`packages/${p} is ${v}, not ${version}: the packages are released together`);
}
const i = process.argv.indexOf("--base");
const base = i === -1 ? `https://github.com/Shogo256/SeamScript/releases/download/v${version}/` : process.argv[i + 1];
if (!base?.endsWith("/")) throw new Error("--base must end with /");

const out = join(root, "release", `v${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const releaseJson = join(root, "packages/create-seamscript/release.json");
writeFileSync(releaseJson, `${JSON.stringify({ base })}\n`);
try {
  for (const p of PACKAGES) {
    const file = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: join(root, "packages", p), encoding: "utf8" }).trim();
    console.log(`release/v${version}/${file}`);
  }
} finally {
  rmSync(releaseJson, { force: true });
}
console.log(`\nStart an app from them:\n  npx ${base}create-seamscript-${version}.tgz my-app`);
