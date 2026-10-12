// Importing this module installs the WASM core before any module that imports
// it runs (top-level await). The compiler adds `import "@seamscript/core"` to
// every file of a production build, so Text is deterministic there.
import { decodeBase64, install } from "./load.js";
import { WASM_BASE64 } from "./wasm.js";

await install(decodeBase64(WASM_BASE64));
