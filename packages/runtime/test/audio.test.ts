import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { __b, type Bytes, EncodeRangeError, Pcm, type Planar } from "../src/index.js";

/** A WAV file: RIFF header, "fmt " (plain or WAVE_FORMAT_EXTENSIBLE), optional extra chunk, "data". */
function wav(o: { code: number; channels: number; rate: number; bits: number; data: Uint8Array; extensible?: boolean; extra?: boolean; dataSize?: number }): Uint8Array<ArrayBuffer> {
  const fmtSize = o.extensible ? 40 : 16;
  const extra = o.extra ? 8 + 3 + 1 : 0; // an odd-sized "LIST" chunk with its pad byte
  const total = 12 + 8 + fmtSize + extra + 8 + o.data.byteLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => out.set([c.charCodeAt(0)], at + i));
  tag(0, "RIFF");
  v.setUint32(4, total - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, fmtSize, true);
  v.setUint16(20, o.extensible ? 0xfffe : o.code, true);
  v.setUint16(22, o.channels, true);
  v.setUint32(24, o.rate, true);
  v.setUint32(28, (o.rate * o.channels * o.bits) / 8, true);
  v.setUint16(32, (o.channels * o.bits) / 8, true);
  v.setUint16(34, o.bits, true);
  if (o.extensible) {
    v.setUint16(36, 22, true);
    v.setUint16(38, o.bits, true);
    v.setUint16(44, o.code, true); // first two bytes of the subformat GUID
  }
  let at = 20 + fmtSize;
  if (o.extra) {
    tag(at, "LIST");
    v.setUint32(at + 4, 3, true);
    at += 12;
  }
  tag(at, "data");
  v.setUint32(at + 4, o.dataSize ?? o.data.byteLength, true);
  out.set(o.data, at + 8);
  return out;
}

const le16 = (...xs: number[]) => {
  const b = new Uint8Array(xs.length * 2);
  xs.forEach((x, i) => new DataView(b.buffer).setInt16(i * 2, x, true));
  return b;
};

const failure = (d: { decode(v: unknown): { ok: boolean } }, v: unknown) => {
  const r = d.decode(v) as { ok: false; error: unknown } | { ok: true };
  return r.ok ? undefined : r.error;
};

describe("Bytes", () => {
  it("views an ArrayBuffer or any view without copying", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    const r = __b.bytes.decode(buf);
    expect(r.ok && [...r.value]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.ok && r.value.buffer).toBe(buf);
    const fromView = __b.bytes.decode(new Uint16Array(buf, 2, 2));
    expect(fromView.ok && [...fromView.value]).toEqual([3, 4, 5, 6]);
    const dv = __b.bytes.decode(new DataView(buf, 1, 2));
    expect(dv.ok && [...dv.value]).toEqual([2, 3]);
  });

  it("refuses everything else, and shared memory, naming only the type", () => {
    expect(failure(__b.bytes, "AAEC")).toEqual({ kind: "decode", path: [], expected: "bytes", actual: "string", rule: "type" });
    expect(failure(__b.bytes, [1, 2])).toMatchObject({ actual: "array", rule: "type" });
    expect(failure(__b.bytes, new Uint8Array(new SharedArrayBuffer(4)))).toMatchObject({ actual: "Uint8Array over a SharedArrayBuffer", rule: "type" });
  });

  it("takes length constraints in bytes", () => {
    const d = __b.length(__b.bytes, 2, 4);
    expect(d.decode(new Uint8Array(3)).ok).toBe(true);
    expect(failure(d, new Uint8Array(5))).toMatchObject({ expected: "bytes of length 2..4", actual: "length 5", rule: "length" });
  });

  it("encodes to itself", () => {
    const r = __b.bytes.decode(new Uint8Array([9]));
    expect(r.ok && __b.bytes.encode(r.value)).toBe(r.ok && r.value);
  });
});

describe("Pcm from plain bytes", () => {
  const mono = __b.pcm("int16", 16000, 1);
  const stereoFloat = __b.pcm("float32", 48000, 2);

  it("reads little-endian Int16 samples", () => {
    const r = mono.decode(le16(0, 1, -1, 32767, -32768).buffer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.value.samples]).toEqual([0, 1, -1, 32767, -32768]);
    expect(r.value).toMatchObject({ format: "int16", sampleRate: 16000, channels: 1, frames: 5 });
    expect(r.value.samples).toBeInstanceOf(Int16Array);
  });

  it("is a view when the bytes are aligned, a copy when they are not", () => {
    const aligned = new Uint8Array(10);
    aligned.set(le16(5, 6), 2);
    const a = mono.decode(aligned.subarray(2, 6));
    expect(a.ok && a.value.samples.buffer).toBe(aligned.buffer);
    const odd = new Uint8Array(10);
    odd.set(le16(5, 6), 1);
    const b = mono.decode(odd.subarray(1, 5));
    expect(b.ok && [...b.value.samples]).toEqual([5, 6]);
    expect(b.ok && b.value.samples.buffer).not.toBe(odd.buffer);
  });

  it("takes the declared format's typed array directly", () => {
    const samples = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const r = stereoFloat.decode(samples);
    expect(r.ok && r.value.samples).toBe(samples);
    expect(r.ok && r.value.frames).toBe(2);
    expect(failure(stereoFloat, new Float32Array(3))).toMatchObject({ rule: "frameAlignment", actual: "3 samples, not a whole number of 2-channel frames" });
  });

  it("reports bytes that are not whole frames", () => {
    expect(failure(mono, new Uint8Array(5))).toEqual({
      kind: "decode",
      path: [],
      expected: "pcm int16 16000 Hz 1ch",
      actual: "5 bytes, not a whole number of 2-byte frames",
      rule: "frameAlignment",
    });
    expect(failure(stereoFloat, new Uint8Array(12))).toMatchObject({ actual: "12 bytes, not a whole number of 8-byte frames", rule: "frameAlignment" });
  });

  it("rejects NaN and infinite Float32 samples", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(failure(stereoFloat, new Float32Array([0, 0, 0, bad]).buffer)).toMatchObject({ rule: "nonFinite", actual: "a non-finite sample at frame 1" });
    }
  });

  it("refuses what is not audio, naming only the type", () => {
    expect(failure(mono, "UklGRg==")).toMatchObject({ rule: "type", actual: "string" });
    expect(failure(mono, { samples: [1] })).toMatchObject({ rule: "type", actual: "object" });
  });

  it("measures length constraints in frames", () => {
    const d = __b.length(stereoFloat, 2, 3);
    expect(d.decode(new Float32Array(4)).ok).toBe(true);
    expect(failure(d, new Float32Array(8))).toMatchObject({ expected: "pcm float32 48000 Hz 2ch of length 2..3", actual: "length 4", rule: "length" });
  });

  it("round-trips through encode as little-endian bytes", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -32768, max: 32767 }), { maxLength: 64 }), (xs) => {
        const r = mono.decode(new Int16Array(xs));
        if (!r.ok) return false;
        const back = mono.decode(mono.encode(r.value));
        return back.ok && [...back.value.samples].join() === xs.join();
      }),
    );
  });

  it("never throws, whatever the bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 96 }), (b) => {
        for (const d of [mono, stereoFloat]) d.decode(b);
        return true;
      }),
    );
  });
});

describe("Pcm from WAV", () => {
  const mono = __b.pcm("int16", 16000, 1);
  const float = __b.pcm("float32", 48000, 2);

  it("reads the samples after the header, plain or extensible, past other chunks", () => {
    for (const shape of [{}, { extensible: true }, { extra: true }]) {
      const r = mono.decode(wav({ code: 1, channels: 1, rate: 16000, bits: 16, data: le16(7, -7, 8), ...shape }).buffer);
      expect(r.ok && [...r.value.samples]).toEqual([7, -7, 8]);
    }
    const f = new Float32Array([0.5, -0.5]);
    const r = float.decode(wav({ code: 3, channels: 2, rate: 48000, bits: 32, data: new Uint8Array(f.buffer) }));
    expect(r.ok && [...r.value.samples]).toEqual([0.5, -0.5]);
  });

  it("takes a data size past the end (a streaming encoder's 0xFFFFFFFF) as up to the end", () => {
    const r = mono.decode(wav({ code: 1, channels: 1, rate: 16000, bits: 16, data: le16(1, 2), dataSize: 0xffffffff }));
    expect(r.ok && [...r.value.samples]).toEqual([1, 2]);
  });

  it("checks the header against the declaration, rule by rule", () => {
    const data = le16(1, 2, 3, 4);
    expect(failure(mono, wav({ code: 1, channels: 1, rate: 48000, bits: 16, data }))).toMatchObject({ rule: "sampleRate", actual: "wav at 48000 Hz" });
    expect(failure(mono, wav({ code: 1, channels: 2, rate: 16000, bits: 16, data }))).toMatchObject({ rule: "channels", actual: "wav with 2 channels" });
    expect(failure(mono, wav({ code: 3, channels: 1, rate: 16000, bits: 32, data }))).toMatchObject({
      rule: "format",
      actual: "wav of format 3, 32-bit (expected 16-bit integer PCM)",
    });
    expect(failure(mono, wav({ code: 1, channels: 1, rate: 16000, bits: 24, data: new Uint8Array(6) }))).toMatchObject({ rule: "format" });
  });

  it("reports a malformed header as a format failure", () => {
    const head = wav({ code: 1, channels: 1, rate: 16000, bits: 16, data: le16(1) });
    expect(failure(mono, head.subarray(0, 12))).toMatchObject({ rule: "format", actual: "wav without a fmt chunk" });
    expect(failure(mono, head.subarray(0, 30))).toMatchObject({ rule: "format", actual: "wav with a truncated fmt chunk" });
    expect(failure(mono, head.subarray(0, 36))).toMatchObject({ rule: "format", actual: "wav without a data chunk" });
  });
});

describe("Planar", () => {
  const mono = __b.planar("float32", 1);
  const stereo = __b.planar("float32", 2);

  it("wraps the channel arrays without copying", () => {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const input = [left, right];
    const r = stereo.decode(input);
    expect(r.ok && r.value.channels).toBe(input);
    expect(r.ok && r.value.channels[0]).toBe(left);
    expect(r.ok && r.value.frames).toBe(128);
  });

  it("fails with rule channels on an input that is not connected", () => {
    expect(failure(mono, [])).toEqual({ kind: "decode", path: [], expected: "planar float32 1ch", actual: "0 channels", rule: "channels" });
    expect(failure(mono, [new Float32Array(2), new Float32Array(2)])).toMatchObject({ rule: "channels", actual: "2 channels" });
  });

  it("checks each channel's type, length and values at its index", () => {
    expect(failure(stereo, [new Float32Array(4), new Int16Array(4)])).toMatchObject({ path: ["1"], rule: "type", actual: "Int16Array" });
    expect(failure(stereo, [new Float32Array(4), new Float32Array(3)])).toMatchObject({ path: ["1"], rule: "frameAlignment", actual: "3 samples" });
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(failure(stereo, [new Float32Array(1), new Float32Array([bad])])).toMatchObject({ path: ["1"], rule: "nonFinite", actual: "a non-finite sample" });
      // Anywhere in a full 128-frame block, not only at the start.
      const block = new Float32Array(128);
      block[127] = bad;
      expect(failure(mono, [block])).toMatchObject({ path: ["0"], rule: "nonFinite" });
    }
    // The largest finite values are fine.
    expect(mono.decode([new Float32Array([3.4028234663852886e38, -3.4028234663852886e38])]).ok).toBe(true);
    expect(failure(stereo, "audio")).toMatchObject({ path: [], rule: "type", actual: "string" });
  });

  it("takes frame-length constraints", () => {
    const d = __b.length(mono, 128, 128);
    expect(d.decode([new Float32Array(128)]).ok).toBe(true);
    expect(failure(d, [new Float32Array(64)])).toMatchObject({ rule: "length", actual: "length 64" });
  });

  it("encodes to its channel arrays, for postMessage", () => {
    const ch = new Float32Array(2);
    const r = mono.decode([ch]);
    expect(r.ok && mono.encode(r.value)).toEqual([ch]);
  });
});

describe("Pcm.of", () => {
  it("makes Pcm from samples the app produced, and they encode", () => {
    const samples = new Int16Array([1, 2, 3, 4]);
    const p = Pcm.of("int16", 16000, 2, samples);
    expect(p).toMatchObject({ format: "int16", sampleRate: 16000, channels: 2, frames: 2, samples });
    expect(new Int16Array(__b.pcm("int16", 16000, 2).encode(p))).toEqual(samples);
  });

  it("throws on samples that don't fit the declaration", () => {
    expect(() => Pcm.of("int16", 16000, 1, new Float32Array(2) as unknown as Int16Array<ArrayBuffer>)).toThrow(TypeError);
    expect(() => Pcm.of("int16", 16000, 2, new Int16Array(3))).toThrow(/whole number of 2-channel frames/);
    expect(() => Pcm.of("float32", 16000, 1, new Float32Array([NaN]))).toThrow(/NaN or infinite/);
    expect(() => Pcm.of("int16", 0, 1, new Int16Array(1))).toThrow(RangeError);
  });

  it("is refused by encode when a field breaks its constraint", () => {
    const d = __b.length(__b.pcm("int16", 16000, 1), 4);
    expect(() => d.encode(Pcm.of("int16", 16000, 1, new Int16Array(2)))).toThrow(EncodeRangeError);
  });
});

it("types the decoded values", () => {
  const p = __b.pcm("int16", 16000, 1).decode(new Int16Array(1));
  if (p.ok) {
    const s: Int16Array<ArrayBuffer> = p.value.samples;
    const rate: 16000 = p.value.sampleRate;
    void [s, rate];
  }
  const q = __b.planar("float32", 2).decode([]);
  if (q.ok) {
    // A literal channel count gives a tuple: both channels are defined.
    const [l, r]: readonly [Float32Array, Float32Array] = q.value.channels;
    const left: Float32Array = q.value.channels[0];
    void [l, r, left];
    const x: Planar<"float32", 2> = q.value;
    void x;
  }
  const b = __b.bytes.decode(new Uint8Array(1));
  if (b.ok) {
    const u: Uint8Array = b.value;
    const brand: Bytes = b.value;
    void [u, brand];
  }
});
