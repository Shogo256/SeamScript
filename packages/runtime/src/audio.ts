import type { Brand } from "./brand.js";

/** Sample formats a `Pcm` or `Planar` boundary type can declare: 16-bit integers or 32-bit floats. */
export type SampleFormat = "int16" | "float32";

/** The typed array that holds samples of format `F`. */
export type Samples<F extends SampleFormat> = F extends "int16" ? Int16Array<ArrayBuffer> : Float32Array<ArrayBuffer>;

/** `C` channel arrays: a tuple for a literal channel count up to 16, an array otherwise. */
export type ChannelArrays<C extends number, Acc extends Float32Array[] = []> = number extends C
  ? readonly Float32Array[]
  : Acc["length"] extends C
    ? Readonly<Acc>
    : Acc["length"] extends 16
      ? readonly Float32Array[]
      : ChannelArrays<C, [...Acc, Float32Array]>;

/** Binary data that passed a boundary: a `Uint8Array` over the bytes received (not a copy). */
export type Bytes = Uint8Array<ArrayBuffer> & Brand<"Bytes">;

/**
 * Interleaved PCM audio that passed a boundary: `samples` holds `frames * channels`
 * samples, channel by channel within each frame. The sample rate and channel count
 * are the ones declared (`Pcm<Int16, 16000, 1>`): a WAV header is checked against
 * them, while plain PCM bytes carry neither and are taken as declared.
 */
export type Pcm<F extends SampleFormat, R extends number, C extends number> = Brand<"Pcm"> & {
  readonly format: F;
  readonly sampleRate: R;
  readonly channels: C;
  /** Samples per channel. */
  readonly frames: number;
  readonly samples: Samples<F>;
};

/**
 * Planar audio that passed a boundary, such as one input of an AudioWorklet's
 * `process`: one Float32Array per channel, all of `frames` samples. The arrays
 * are the ones received, not copies; the audio thread reuses them after
 * `process` returns, so copy what you keep.
 */
export type Planar<F extends "float32", C extends number> = Brand<"Planar"> & {
  readonly format: F;
  readonly channels: ChannelArrays<C>;
  /** Samples per channel. */
  readonly frames: number;
};

const SAMPLE_BYTES: Record<SampleFormat, number> = { int16: 2, float32: 4 };

export const Pcm = {
  /**
   * Interleaved samples as `Pcm`, for audio the app produces itself (to send it
   * with `Name.encode`, for example). Throws if the samples don't match the
   * declaration: the wrong typed array for the format, a length that isn't a whole
   * number of frames, or a non-finite Float32 sample.
   */
  of<F extends SampleFormat, R extends number, C extends number>(format: F, sampleRate: R, channels: C, samples: Samples<F>): Pcm<F, R, C> {
    const Array = format === "int16" ? Int16Array : Float32Array;
    if (!(samples instanceof Array)) throw new TypeError(`Pcm.of: ${format} samples must be a ${Array.name}`);
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`Pcm.of: sample rate ${sampleRate} is not a positive integer`);
    if (!Number.isSafeInteger(channels) || channels <= 0) throw new RangeError(`Pcm.of: channel count ${channels} is not a positive integer`);
    if (samples.length % channels !== 0) throw new RangeError(`Pcm.of: ${samples.length} samples are not a whole number of ${channels}-channel frames`);
    if (format === "float32" && firstNonFinite(samples as Float32Array) !== -1) throw new RangeError("Pcm.of: a sample is NaN or infinite");
    return { format, sampleRate, channels, frames: samples.length / channels, samples } as unknown as Pcm<F, R, C>;
  },
};

/** Bytes per sample of each format. */
export function sampleBytes(format: SampleFormat): number {
  return SAMPLE_BYTES[format];
}

/** Index of the first NaN or infinite sample, or -1. */
export function firstNonFinite(a: Float32Array): number {
  // x - x is 0 for every finite x, and NaN for NaN and both infinities.
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x - x !== 0) return i;
  }
  return -1;
}

/** Whether this platform stores multi-byte numbers little-endian, as PCM and WAV do. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * The samples in `bytes` (little-endian) as a typed array: a view when the
 * offset is aligned and the platform is little-endian, a copy otherwise.
 */
export function samplesOf<F extends SampleFormat>(format: F, bytes: Uint8Array<ArrayBuffer>): Samples<F> {
  const size = SAMPLE_BYTES[format];
  const count = bytes.byteLength / size;
  if (LITTLE_ENDIAN && bytes.byteOffset % size === 0) {
    return (format === "int16" ? new Int16Array(bytes.buffer, bytes.byteOffset, count) : new Float32Array(bytes.buffer, bytes.byteOffset, count)) as Samples<F>;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "int16") {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
    return out as Samples<F>;
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out as Samples<F>;
}

/** Little-endian bytes of `samples`: their own buffer when it holds exactly them, a copy otherwise. */
export function bytesOf(samples: Int16Array<ArrayBuffer> | Float32Array<ArrayBuffer>): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = samples;
  if (LITTLE_ENDIAN) return byteOffset === 0 && byteLength === buffer.byteLength ? buffer : buffer.slice(byteOffset, byteOffset + byteLength);
  const out = new ArrayBuffer(byteLength);
  const view = new DataView(out);
  if (samples instanceof Int16Array) for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  else for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i]!, true);
  return out;
}

/** What a WAV file's header says, and where its samples are. */
export interface WavInfo {
  /** WAVE_FORMAT_PCM (1), WAVE_FORMAT_IEEE_FLOAT (3), or the subformat of WAVE_FORMAT_EXTENSIBLE. */
  formatCode: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Uint8Array<ArrayBuffer>;
}

const RIFF = 0x46464952; // "RIFF" read little-endian
const WAVE = 0x45564157; // "WAVE"
const FMT = 0x20746d66; // "fmt "
const DATA = 0x61746164; // "data"

/** Whether `bytes` start like a WAV file ("RIFF", size, "WAVE"). */
export function isWav(bytes: Uint8Array<ArrayBuffer>): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === RIFF && view.getUint32(8, true) === WAVE;
}

/**
 * Reads a WAV header: the "fmt " chunk and the extent of the "data" chunk. A data
 * size larger than what is there (0xFFFFFFFF from a streaming encoder, or a
 * truncated file) is taken as "up to the end". Returns a problem description
 * when the chunks are missing or malformed.
 */
export function readWav(bytes: Uint8Array<ArrayBuffer>): WavInfo | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<WavInfo, "data"> | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = view.getUint32(at, true);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === FMT) {
      if (size < 16 || body + 16 > bytes.byteLength) return "wav with a truncated fmt chunk";
      let formatCode = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the subformat GUID.
      if (formatCode === 0xfffe) {
        if (size < 40 || body + 26 > bytes.byteLength) return "wav with a truncated extensible fmt chunk";
        formatCode = view.getUint16(body + 24, true);
      }
      fmt = { formatCode, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) };
    } else if (id === DATA) {
      if (fmt === undefined) return "wav with data before its fmt chunk";
      const end = Math.min(body + size, bytes.byteLength);
      return { ...fmt, data: bytes.subarray(body, end) };
    }
    // Chunks are padded to an even size.
    at = body + size + (size & 1);
  }
  return fmt === undefined ? "wav without a fmt chunk" : "wav without a data chunk";
}
