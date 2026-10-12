import { __coreFailed, __installCore } from "@seamscript/runtime";
import { type CoreExports, createCore } from "./core.js";

/**
 * Instantiates the WASM module and installs it into the runtime. Never rejects:
 * a failure (a CSP without 'wasm-unsafe-eval', no WebAssembly at all) is recorded
 * instead, so the app still starts and Text operations throw CoreUnavailableError
 * rather than silently falling back to the host's ICU.
 */
export async function install(bytes: BufferSource): Promise<void> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes);
    __installCore(createCore(instance.exports as unknown as CoreExports));
  } catch (e) {
    __coreFailed(e);
  }
}

export function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  return native ? native(s) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
