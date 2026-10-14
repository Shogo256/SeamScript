#!/usr/bin/env node
// As tsc does, keep compiled code in Node's on-disk cache: loading TypeScript's
// API otherwise costs a few hundred milliseconds on every run. It must be
// enabled before the modules load, hence the dynamic import.
import module from "node:module";

module.enableCompileCache?.();
const { main } = await import("../dist/cli.js");
process.exitCode = main(process.argv.slice(2));
