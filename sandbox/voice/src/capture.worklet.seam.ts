// Runs on the audio thread: hands each block of microphone input to the page.

// One input of `process`: mono, since the node mixes its input down to one channel.
boundary Block = Planar<Float32, 1>

class Capture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    // Before the microphone is connected the input has no channels, and this fails.
    const block = decode Block from inputs[0];
    if (block.ok) {
      // The audio thread reuses its arrays once process returns: send a copy.
      const copy = block.value.channels[0].slice();
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("capture", Capture);
