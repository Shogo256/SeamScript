// The JavaScript side of the C ABI in src/wasm.rs.
import type { TextCore } from "@seamscript/runtime";

export interface CoreExports {
  memory: WebAssembly.Memory;
  seam_alloc(len: number): number;
  seam_free(ptr: number, len: number): void;
  seam_free_u32(ptr: number, len: number): void;
  seam_result(): number;
  seam_normalize(ptr: number, len: number, form: number): number;
  seam_graphemes(ptr: number, len: number): number;
  seam_unicode_version(): number;
}

const encoder = new TextEncoder();
// ignoreBOM: by default a decoder drops a leading U+FEFF, which is text here, not a BOM.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function createCore(x: CoreExports): TextCore {
  const resultSlot = x.seam_result();

  // Views are created after each call: a call may grow WASM memory, which
  // detaches every earlier view of its buffer.
  const result = (status: number): [ptr: number, len: number] => {
    if (status !== 0) throw new Error("@seamscript/core: input was not valid UTF-8");
    const slot = new Uint32Array(x.memory.buffer, resultSlot, 2);
    return [slot[0]!, slot[1]!];
  };

  // Copies `s` into WASM memory as UTF-8 for the duration of `f`.
  const withInput = <T>(s: string, f: (ptr: number, len: number) => T): T => {
    const capacity = s.length * 3; // UTF-8 needs at most 3 bytes per UTF-16 code unit
    const ptr = x.seam_alloc(capacity);
    try {
      const { written } = encoder.encodeInto(s, new Uint8Array(x.memory.buffer, ptr, capacity));
      return f(ptr, written);
    } finally {
      x.seam_free(ptr, capacity);
    }
  };

  const v = x.seam_unicode_version();
  return {
    unicodeVersion: `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`,

    normalize: (s, form) =>
      withInput(s, (ptr, len) => {
        const [out, n] = result(x.seam_normalize(ptr, len, form === "NFC" ? 0 : 1));
        try {
          return decoder.decode(new Uint8Array(x.memory.buffer, out, n));
        } finally {
          x.seam_free(out, n);
        }
      }),

    graphemeBoundaries: (s) =>
      withInput(s, (ptr, len) => {
        const [out, n] = result(x.seam_graphemes(ptr, len));
        try {
          return new Uint32Array(x.memory.buffer, out, n).slice();
        } finally {
          x.seam_free_u32(out, n);
        }
      }),
  };
}
