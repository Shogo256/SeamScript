// The cost of the boundary inside an AudioWorklet's `process`, per call: decoding
// one 128-frame input as `Planar<Float32, C>`, and the voice sample's whole body
// (decode, then copy the block to post it). At 48 kHz `process` runs every
// 128 / 48000 s = 2.67 ms, which is the budget for everything the audio thread does.
//
//   yarn build && node bench/process.ts [--calls 10000] [--rounds 15]
//
// Each round times a batch of calls with performance.now() and divides by the
// batch size; the median round is reported, with the fastest and slowest.
import { __b } from "../dist/index.js";

const FRAMES = 128;
const BUDGET_US = (FRAMES / 48_000) * 1e6;

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const CALLS = arg("--calls", 10_000);
const ROUNDS = arg("--rounds", 15);

/** One input as the audio thread hands it over: one Float32Array per channel, reused from call to call. */
function input(channels: number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: FRAMES }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (i + c)) / 48_000)));
}

let sink = 0; // keeps the work observable, so it can't be optimized away

function measure(name: string, body: () => void): void {
  for (let i = 0; i < 20_000; i++) body(); // warm up the JIT
  const perCall: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < CALLS; i++) body();
    perCall.push(((performance.now() - t0) * 1000) / CALLS);
  }
  perCall.sort((a, b) => a - b);
  const median = perCall[Math.floor(perCall.length / 2)]!;
  const share = (median / BUDGET_US) * 100;
  console.log(
    `${name.padEnd(44)} median ${median.toFixed(3)} µs  (min ${perCall[0]!.toFixed(3)}, max ${perCall.at(-1)!.toFixed(3)})  ${share.toFixed(3)}% of ${BUDGET_US.toFixed(0)} µs`,
  );
}

const mono = __b.planar("float32", 1);
const stereo = __b.planar("float32", 2);
const monoInput = input(1);
const stereoInput = input(2);

console.log(`${CALLS} calls per round, ${ROUNDS} rounds, ${FRAMES} frames per call, Node ${process.versions.node}`);
measure("decode Planar<Float32, 1>", () => {
  const r = mono.decode(monoInput);
  if (r.ok) sink += r.value.frames;
});
measure("decode Planar<Float32, 2>", () => {
  const r = stereo.decode(stereoInput);
  if (r.ok) sink += r.value.frames;
});
measure("decode Planar<Float32, 1> + copy the block", () => {
  const r = mono.decode(monoInput);
  if (r.ok) sink += r.value.channels[0].slice()[FRAMES - 1]!;
});
measure("copy the block only (no boundary)", () => {
  sink += monoInput[0]!.slice()[FRAMES - 1]!;
});
measure("failing decode: input not connected", () => {
  const r = mono.decode([]);
  if (!r.ok) sink += r.error.path.length;
});
if (Number.isNaN(sink)) console.log(sink);
