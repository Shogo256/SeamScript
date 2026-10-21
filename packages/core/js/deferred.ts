// The core without holding up start-up. `@seamscript/core` installs the WASM
// core with a top-level await, so every module that imports it (in a production
// build, every .seam.ts module that uses Text) finishes evaluating only after the
// core is ready, which can be after the page's load event. This entry starts the
// same load and returns at once: modules run in their usual order, and Text
// operations before the core is ready throw CoreUnavailableError with
// `loading: true`. Await `Text.ready` before the first one.
import { __coreLoading } from "@seamscript/runtime";
import { decodeBase64, install } from "./load.js";
import { WASM_BASE64 } from "./wasm.js";

__coreLoading(install(decodeBase64(WASM_BASE64)));
