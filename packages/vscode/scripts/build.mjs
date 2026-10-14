// Packages the extension as a .vsix: the manifest, the grammar and the tsserver
// plugin, which VS Code loads from the extension's node_modules. The plugin is
// one bundled file (packages/ts-plugin/dist/index.cjs), so nothing else is needed.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "dist/extension");
const require = createRequire(import.meta.url);
const pluginDir = dirname(require.resolve("@seamscript/ts-plugin/package.json"));

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pluginVersion = manifest.devDependencies["@seamscript/ts-plugin"];
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.private;
delete manifest.type;
// A dependency, so that vsce packs it from node_modules (npm list finds it there).
manifest.dependencies = { "@seamscript/ts-plugin": pluginVersion };
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, "README.md"), join(stage, "README.md"));
cpSync(join(root, "../../LICENSE"), join(stage, "LICENSE"));
cpSync(join(root, "syntaxes"), join(stage, "syntaxes"), { recursive: true });
// The stage holds only what ships; source maps stay out.
writeFileSync(join(stage, ".vscodeignore"), "**/*.map\n");

const plugin = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const target = join(stage, "node_modules/@seamscript/ts-plugin");
mkdirSync(join(target, "dist"), { recursive: true });
writeFileSync(join(target, "package.json"), `${JSON.stringify({ name: plugin.name, version: plugin.version, main: plugin.main, license: plugin.license }, null, 2)}\n`);
cpSync(join(pluginDir, "dist/index.cjs"), join(target, "dist/index.cjs"));
cpSync(join(root, "../../LICENSE"), join(target, "LICENSE"));

const vsix = join(root, "dist", `${manifest.name}-${manifest.version}.vsix`);
execFileSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--allow-missing-repository", "--out", vsix], { cwd: stage, stdio: "inherit" });
