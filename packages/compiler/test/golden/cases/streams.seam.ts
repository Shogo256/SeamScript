// A ChunkStream over a boundary, and Pcm made by the app.
boundary Caption { seq: number, text: Text<NFC>, final: boolean }

export function captions(ws: WebSocket, show: (c: Caption) => void) {
  const stream = ChunkStream.of(Caption, { seq: (c) => c.seq, gap: { wait: 300, then: "drop" }, late: "error" }, (event) => {
    if (event.kind === "chunk") show(event.value);
  });
  ws.onmessage = (e) => stream.push(e.data);
  ws.onclose = () => stream.reset();
  return stream;
}

boundary Chunk = Pcm<Int16, 16000, 1>

export function send(ws: WebSocket, samples: Int16Array<ArrayBuffer>) {
  ws.send(Chunk.encode(Pcm.of("int16", 16000, 1, samples)));
}
