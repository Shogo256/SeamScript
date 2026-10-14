#!/usr/bin/env node
// sandbox-backend [--port $PORT] [--host 127.0.0.1] [--seed 1] [--instruments 40] [--orders 30]
//                 [--tps 20] [--heartbeat 1000] [--static /=../app/dist ...]
// Prints one JSON line, {"url": ...}, once it is listening.
import "@seamscript/core"; // Text counts graphemes with the same Unicode version as the app
import { Text } from "@seamscript/runtime";
import { startServer, type ServerOptions } from "./server.ts";

const options: ServerOptions = { statics: {}, driver: {}, ...(process.env["PORT"] ? { port: Number(process.env["PORT"]) } : {}) };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const v = argv[++i];
  if (v === undefined) throw new Error(`${a} needs a value`);
  switch (a) {
    case "--port":
      options.port = Number(v);
      break;
    case "--host":
      options.host = v;
      break;
    case "--seed":
      options.seed = Number(v);
      break;
    case "--instruments":
      options.instruments = Number(v);
      break;
    case "--orders":
      options.orders = Number(v);
      break;
    case "--tps":
      options.driver!.ticksPerSecond = Number(v);
      break;
    case "--heartbeat":
      options.driver!.heartbeatMs = Number(v);
      break;
    case "--static": {
      const eq = v.indexOf("=");
      if (eq < 0) throw new Error("--static takes prefix=dir");
      options.statics![v.slice(0, eq)] = v.slice(eq + 1);
      break;
    }
    default:
      throw new Error(`unknown option ${a}`);
  }
}

if (!Text.deterministic) throw new Error("@seamscript/core did not load");
const server = await startServer(options);
console.log(JSON.stringify({ url: server.url, unicode: Text.unicodeVersion }));

const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
