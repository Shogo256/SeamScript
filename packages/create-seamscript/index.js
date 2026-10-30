#!/usr/bin/env node
// npm create seamscript [directory] [-- --template react|vanilla]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const TEMPLATES = ["react", "vanilla"];
const here = fileURLToPath(new URL(".", import.meta.url));
// Every @seamscript package is released with the same version as this one.
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

/**
 * Where the @seamscript packages come from. From npm by default; a copy built
 * for a GitHub release carries `release.json`, `{ "base": "<url>/" }`, and then
 * every @seamscript package is that release's tarball, so `npm install` needs
 * nothing from the npm registry under the @seamscript scope.
 */
const release = (() => {
  try {
    return JSON.parse(readFileSync(join(here, "release.json"), "utf8"));
  } catch {
    return undefined;
  }
})();

/** The dependency spec of an @seamscript package: its version, or its tarball in the release. */
export function seamSpec(name, from = release) {
  return from === undefined ? version : `${from.base}${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

const USAGE = `Usage: npm create seamscript [directory] [-- --template ${TEMPLATES.join("|")}]

  directory         Where to create the app (default: seamscript-app)
  -t, --template    react (Vite + React, the default) or vanilla (Vite, no framework)
  -h, --help        Show this help`;

/** The package versions a new app starts with. */
const VERSIONS = {
  react: "^19.3.0",
  "react-dom": "^19.3.0",
  "@types/react": "^19.3.0",
  "@types/react-dom": "^19.3.0",
  "@vitejs/plugin-react": "^6.1.2",
  typescript: "~5.9.3",
  vite: "^8.3.4",
};

/** The Node.js versions seamc runs on: those of Babel 8, which its parser is a fork of. */
export const NODE_RANGE = "^22.18.0 || >=24.11.0";

/** Whether `version` ("22.18.0", without the "v") is in NODE_RANGE. */
export function nodeSupported(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major > 24;
}

export function parseArgs(argv) {
  const args = { directory: undefined, template: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-t" || a === "--template") args.template = argv[++i];
    else if (a.startsWith("--template=")) args.template = a.slice("--template=".length);
    else if (a.startsWith("-")) return `Unknown option ${a}`;
    else if (args.directory === undefined) args.directory = a;
    else return `Unexpected argument ${a}`;
  }
  if (args.template !== undefined && !TEMPLATES.includes(args.template)) {
    return `Unknown template ${args.template}; choose ${TEMPLATES.join(" or ")}`;
  }
  return args;
}

/** A valid npm package name from a directory name. */
export function packageName(directory) {
  const name = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+|-+$/g, "");
  return name || "seamscript-app";
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function packageJson(name, template) {
  const react = template === "react";
  return json({
    name,
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: {
      dev: "vite",
      check: "seamc check",
      build: "seamc check && vite build",
      preview: "vite preview",
    },
    dependencies: {
      "@seamscript/core": seamSpec("@seamscript/core"),
      ...(react ? { "@seamscript/react": seamSpec("@seamscript/react") } : {}),
      "@seamscript/runtime": seamSpec("@seamscript/runtime"),
      ...(react ? { react: VERSIONS.react, "react-dom": VERSIONS["react-dom"] } : {}),
    },
    engines: { node: NODE_RANGE },
    devDependencies: {
      "@seamscript/compiler": seamSpec("@seamscript/compiler"),
      "@seamscript/ts-plugin": seamSpec("@seamscript/ts-plugin"),
      ...(react ? { "@types/react": VERSIONS["@types/react"], "@types/react-dom": VERSIONS["@types/react-dom"], "@vitejs/plugin-react": VERSIONS["@vitejs/plugin-react"] } : {}),
      typescript: VERSIONS.typescript,
      vite: VERSIONS.vite,
    },
    // The compiler depends on @seamscript/parser by version, which the registry
    // doesn't have when the packages come from a release.
    ...(release === undefined ? {} : { overrides: { "@seamscript/parser": seamSpec("@seamscript/parser") } }),
  });
}

function tsconfig(template) {
  return json({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      ...(template === "react" ? { jsx: "react-jsx" } : {}),
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      // Editors other than VS Code (which loads it through the SeamScript extension).
      plugins: [{ name: "@seamscript/ts-plugin" }],
    },
    include: ["src"],
    // SeamScript's own settings: more sources of outside data, library `any`.
    seamscript: { edition: "2026", sources: [], externalAny: "unknown" },
  });
}

function viteConfig(template) {
  const react = template === "react";
  return [
    'import seamscript from "@seamscript/compiler/vite";',
    ...(react ? ['import react from "@vitejs/plugin-react";'] : []),
    'import { defineConfig } from "vite";',
    "",
    "// `vite build` bundles the WASM core into the files that use Text, so every",
    "// browser normalizes and counts text the same way; `vite` (development) uses",
    "// the browser's own Unicode data.",
    "export default defineConfig({",
    `  plugins: [seamscript()${react ? ", react()" : ""}],`,
    '  build: { target: "es2022" },',
    "});",
    "",
  ].join("\n");
}

function indexHtml(template) {
  const body =
    template === "react"
      ? '    <div id="root"></div>\n    <script type="module" src="/src/main.seam.tsx"></script>'
      : [
          "    <main>",
          "      <h1>SeamScript</h1>",
          '      <p><button data-id="1">Person 1</button> <button data-id="2">Person 2</button> <button data-id="3">Person 3</button></p>',
          '      <dl id="person">Loading…</dl>',
          "    </main>",
          '    <script type="module" src="/src/main.seam.ts"></script>',
        ].join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SeamScript app</title>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function readme(name) {
  return `# ${name}

A [SeamScript](https://github.com/Shogo256/SeamScript) app: data from outside the program is \`Unknown\` until a \`decode\` checks it.

- \`npm run dev\`: start Vite's development server
- \`npm run check\`: type-check, including SeamScript's rules (\`seamc check\`)
- \`npm run build\`: check, then build for production with the WASM core

\`src/people.seam.ts\` declares a boundary and a latest function; \`public/people/3.json\` holds data that fails to decode, to show what a DecodeError looks like.

In VS Code, install the SeamScript extension for completion, navigation and diagnostics in \`.seam.ts\` files.
`;
}

/** Writes a new app into `directory`, which must be missing or empty. */
export function create(directory, template) {
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${directory} is not empty; choose a new directory.`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(join(here, "templates", "shared"), target, { recursive: true });
  cpSync(join(here, "templates", template), target, { recursive: true });
  // npm leaves .gitignore out of published packages, so it ships under another name.
  renameSync(join(target, "_gitignore"), join(target, ".gitignore"));
  const name = packageName(directory);
  writeFileSync(join(target, "package.json"), packageJson(name, template));
  writeFileSync(join(target, "tsconfig.json"), tsconfig(template));
  writeFileSync(join(target, "vite.config.ts"), viteConfig(template));
  writeFileSync(join(target, "index.html"), indexHtml(template));
  writeFileSync(join(target, "README.md"), readme(name));
  return target;
}

async function main(argv) {
  // Checked first: on an older Node the app's npm install half-works and the dev
  // server then fails with an error about native bindings that says nothing of this.
  if (!nodeSupported(process.versions.node)) {
    console.error(`SeamScript needs Node.js ${NODE_RANGE.replace("^", "").replace(" || >=", " or later, or ")} or later; this is ${process.version}.`);
    return 1;
  }
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(`${args}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  let { directory, template } = args;
  if (directory === undefined && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    directory = (await rl.question("Project directory (seamscript-app): ")).trim() || undefined;
    if (template === undefined) {
      const answer = (await rl.question(`Template, ${TEMPLATES.join(" or ")} (react): `)).trim() || "react";
      if (!TEMPLATES.includes(answer)) {
        rl.close();
        console.error(`Unknown template ${answer}; choose ${TEMPLATES.join(" or ")}`);
        return 2;
      }
      template = answer;
    }
    rl.close();
  }
  directory ??= "seamscript-app";
  template ??= "react";
  let target;
  try {
    target = create(directory, template);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const cd = relative(process.cwd(), target) || ".";
  const pm = /^(pnpm|yarn|bun)\//.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;
  console.log(`\nCreated a SeamScript app (${template}) in ${cd}. Next:\n`);
  if (cd !== ".") console.log(`  cd ${cd}`);
  console.log(`  ${pm} install\n  ${run} dev\n`);
  return 0;
}

// Run as a command (npm links the bin), not when imported by the tests.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
