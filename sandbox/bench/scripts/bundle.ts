// What a browser downloads for each build's page: the scripts, module preloads
// and stylesheets index.html references (source maps and other pages excluded).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { sandbox } from "./lib.ts";

export interface BundleSize {
  files: string[];
  raw: number;
  gzip: number;
  brotli: number;
}

function size(dist: string, base: string): BundleSize {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!.slice(base.length));
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const f of files) {
    const bytes = readFileSync(join(dist, f));
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    brotli += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  }
  return { files, raw, gzip, brotli };
}

export function bundle(): Record<string, BundleSize> {
  return {
    "SeamScript (WASM core)": size(join(sandbox, "app/dist"), "/"),
    "SeamScript (no core)": size(join(sandbox, "app/dist-no-core"), "/no-core/"),
    "TypeScript + Zod": size(join(sandbox, "app-ts/dist"), "/ts/"),
  };
}
