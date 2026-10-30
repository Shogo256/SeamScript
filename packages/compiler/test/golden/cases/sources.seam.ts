// Where outside data enters: the lib's sources, the project's own, and an AudioWorklet's inputs.
import { MicChunk, Quantum } from "./shapes.seam";

declare const NativeBridge: { receive(): string };
declare function readConfig(): Promise<object>;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

boundary MicSettings { sampleRate?: number in 8000..384000, channelCount?: number }

export async function sources(track: MediaStreamTrack, file: File, ws: WebSocket) {
  const settings = decode MicSettings from track.getSettings();
  const bytes = decode Bytes from await file.arrayBuffer();
  const body = decode MicChunk from await (await fetch("/audio")).arrayBuffer();
  const saved = decode string from localStorage.getItem("k");
  const q = decode string from new URLSearchParams(location.search).get("q");
  const native = decode string from NativeBridge.receive();
  const config = decode string[] from await readConfig();
  ws.onmessage = (e) => void decode MicChunk from e.data;
  return [settings, bytes, body, saved, q, native, config];
}

export class Capture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const block = decode Quantum from inputs[0];
    if (block.ok) this.port.postMessage(block.value.channels[0].slice());
    return inputs.length > 0;
  }
}
