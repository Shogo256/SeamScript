/// <reference types="node" />
// Outside data in Node.js: the environment and files. Values come back as an
// Unknown that hides them at run time as well (see `__box`): anything but
// `decode` throws UnknownAccess, so they can't be used unchecked even from code
// the compiler never saw.
//
//   import { env, file } from "@seamscript/runtime/node";
//   const port = decode Int64 from env.get("PORT");
import { readFile } from "node:fs/promises";
import process from "node:process";
import { type Unknown, __box } from "./unknown.js";

export { UnknownAccess } from "./unknown.js";

export const env = {
  /** `process.env[name]`, also when it is not set (it then decodes as `undefined`, which most targets reject). */
  get(name: string): Unknown {
    return __box(process.env[name]);
  },
  /** A copy of `process.env` as it is now. */
  all(): Unknown {
    return __box({ ...process.env });
  },
};

export const file = {
  /** The file's text (UTF-8). Rejects as `fs.readFile` does when the file can't be read. */
  async readText(path: string | URL): Promise<Unknown> {
    return __box(await readFile(path, "utf8"));
  },
  /**
   * The file's text parsed as JSON. Rejects when the file can't be read, or with a
   * SyntaxError naming only the path when it is not JSON (JSON.parse's own message
   * quotes the text, which may be private). To get malformed JSON back as a
   * DecodeError instead, use `decode T from json await file.readText(path)`.
   */
  async readJson(path: string | URL): Promise<Unknown> {
    const text = await readFile(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SyntaxError(`${String(path)} is not valid JSON`);
    }
    return __box(value);
  },
};
