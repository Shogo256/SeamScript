// A minimal tsserver client: the same server, protocol and plugin loading as an
// editor (VS Code runs tsserver the same way), so these tests exercise the
// plugin as editors use it.
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";

const tsserverPath = createRequire(import.meta.url).resolve("typescript/lib/tsserver.js");

export interface Position {
  line: number;
  offset: number;
}

export class TsServer {
  private readonly proc: ChildProcess;
  private seq = 0;
  private readonly pending = new Map<number, (r: { success: boolean; body?: unknown; message?: string }) => void>();
  private buffer = Buffer.alloc(0);
  readonly log: string[] = [];

  /** `plugins` are loaded for every project, as an editor extension does (VS Code's typescriptServerPlugins). */
  constructor(options: { plugins?: string[]; probeLocation?: string } = {}) {
    const args = [tsserverPath, "--disableAutomaticTypingAcquisition", "--suppressDiagnosticEvents"];
    if (options.plugins) args.push("--globalPlugins", options.plugins.join(","), "--pluginProbeLocations", options.probeLocation ?? "");
    this.proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => this.log.push(chunk.toString()));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = this.buffer.indexOf("\r\n\r\n");
      if (header < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(this.buffer.subarray(0, header).toString())?.[1]);
      if (this.buffer.length < header + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(header + 4, header + 4 + length).toString());
      this.buffer = this.buffer.subarray(header + 4 + length);
      if (message.type === "response") this.pending.get(message.request_seq)?.(message);
    }
  }

  private send(command: string, args: unknown, expectResponse: boolean): Promise<unknown> {
    const seq = ++this.seq;
    this.proc.stdin!.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    if (!expectResponse) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.pending.set(seq, (r) => (r.success ? resolve(r.body) : reject(new Error(`${command}: ${r.message}`))));
    });
  }

  request<T>(command: string, args: unknown): Promise<T> {
    return this.send(command, args, true) as Promise<T>;
  }

  async open(file: string, content?: string): Promise<void> {
    await this.send("open", { file, fileContent: content, scriptKindName: file.endsWith("x") ? "TSX" : "TS" }, false);
  }

  async change(file: string, start: Position, end: Position, insertString: string): Promise<void> {
    await this.send("change", { file, line: start.line, offset: start.offset, endLine: end.line, endOffset: end.offset, insertString }, false);
  }

  close(): void {
    this.proc.kill();
  }
}

/** The 1-based line/offset of the `nth` occurrence of `needle` in `text`, plus `delta` characters. */
export function at(text: string, needle: string, delta = 0, nth = 0): Position {
  let i = -1;
  for (let k = 0; k <= nth; k++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`${JSON.stringify(needle)} not found`);
  }
  const before = text.slice(0, i + delta);
  const line = before.split("\n").length;
  return { line, offset: before.length - before.lastIndexOf("\n") };
}
