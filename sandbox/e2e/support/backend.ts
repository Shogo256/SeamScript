// A pseudo backend in its own process, one per Playwright worker, driven through its admin API.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)); // sandbox/

export interface ServerState {
  epoch: string;
  seq: string;
  serverTime: string;
  instruments: { id: string; symbol: string; name: string; tickSize: string; last: string; prevClose: string; version: string; updatedAt: string }[];
  orders: {
    id: string;
    clientOrderId: string;
    instrumentId: string;
    side: string;
    quantity: string;
    filled: string;
    price: string;
    status: string;
    memo: string;
    version: string;
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface Stats {
  epoch: string;
  seq: string;
  http: { requests: Record<string, number>; aborted: Record<string, number>; errors: number; corrupted: number; committedThenFailed: number };
  ws: Record<string, number>;
}

export type FaultsPatch = { ws?: Record<string, unknown>; http?: Record<string, unknown>; csp?: "none" | "wasm" | "strict" };

export class Backend {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  }

  reset(options: { seed?: number; instruments?: number; orders?: number } = {}) {
    return this.call<{ epoch: string; seq: string }>("POST", "/admin/reset", options);
  }

  faults(patch: FaultsPatch) {
    return this.call("POST", "/admin/faults", patch);
  }

  clearFaults() {
    return this.call("POST", "/admin/faults/clear", {});
  }

  driver(patch: { ticksPerSecond?: number; externalOrdersPerSecond?: number; heartbeatMs?: number; paused?: boolean; stamp?: boolean }) {
    return this.call("POST", "/admin/driver", patch);
  }

  state() {
    return this.call<ServerState>("GET", "/admin/state");
  }

  stats() {
    return this.call<Stats>("GET", "/admin/stats");
  }

  tick(count = 1) {
    return this.call<{ seq: string }>("POST", "/admin/tick", { count });
  }

  disconnect(mode: "close" | "terminate" = "close") {
    return this.call("POST", "/admin/disconnect", { mode });
  }

  broadcast(frame: string, binary = false) {
    return this.call<{ clients: number }>("POST", "/admin/broadcast", { frame, binary });
  }
}

export interface ServerProcess {
  url: string;
  stop(): Promise<void>;
}

/** Starts sandbox/backend serving the built apps; resolves once it prints its URL. */
export async function startBackend(args: string[] = []): Promise<ServerProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "backend/src/main.ts",
      "--port",
      "0",
      "--static",
      "/=app/dist",
      "--static",
      "/no-core/=app/dist-no-core",
      "--static",
      "/ts/=app-ts/dist",
      "--static",
      "/ucd/=../packages/core/.ucd/17.0.0",
      "--static",
      "/voice/=voice/dist",
      ...args,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`backend exited with ${code}`)));
  });
  const { url } = JSON.parse(line) as { url: string };
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}
