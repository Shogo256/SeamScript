// @seamscript/runtime/node: values from the environment and files are Unknown at
// run time too. Every operation other than decode throws UnknownAccess.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { __b, __decode, __decodeJson, Unknown, UnknownAccess } from "../src/index.js";
import { env, file } from "../src/node.js";

const dir = mkdtempSync(join(tmpdir(), "seam-node-"));
const json = join(dir, "config.json");
const broken = join(dir, "broken.json");
beforeAll(() => {
  process.env["SEAM_TEST_PORT"] = "8080";
  writeFileSync(json, '{"name":"secret-name","ports":[1,2]}');
  writeFileSync(broken, '{"password": "hunter2"');
});
afterAll(() => {
  delete process.env["SEAM_TEST_PORT"];
  rmSync(dir, { recursive: true, force: true });
});

// Any value works: the box hides objects, arrays and strings alike.
const box = () => env.get("SEAM_TEST_PORT") as unknown as Record<PropertyKey, unknown>;
const anyBox = () => box() as any;

/** The operation throws UnknownAccess, naming `operation` and never the value. */
function denies(run: () => unknown, operation: string) {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UnknownAccess);
  expect((caught as UnknownAccess).operation).toBe(operation);
  expect((caught as Error).message).not.toContain("8080");
}

describe("every use other than decode throws UnknownAccess", () => {
  it("reading a property", () => denies(() => box()["length"], "reading .length"));
  it("indexing", () => denies(() => box()[0], "reading .0"));
  it("iterating with for...of", () =>
    denies(() => {
      for (const x of anyBox()) void x;
    }, "iterating over it"));
  it("spreading into an array", () => denies(() => [...anyBox()], "iterating over it"));
  it("spreading into an object", () => denies(() => ({ ...box() }), "listing its keys"));
  it("Object.keys", () => denies(() => Object.keys(box()), "listing its keys"));
  it("JSON.stringify", () => denies(() => JSON.stringify(box()), "JSON.stringify"));
  it("String()", () => denies(() => String(box()), "converting it to a string or number"));
  it("a template literal", () => denies(() => `${anyBox()}`, "converting it to a string or number"));
  it("concatenation with +", () => denies(() => anyBox() + "", "converting it to a string or number"));
  it("Number()", () => denies(() => Number(box()), "converting it to a string or number"));
  it("calling toString", () => denies(() => anyBox().toString(), "converting it to a string or number"));
  it("testing a key with in", () => denies(() => "length" in box(), 'testing "length" with `in`'));
  it("writing a property", () =>
    denies(() => {
      box()["x"] = 1;
    }, "writing .x"));
  it("deleting a property", () =>
    denies(() => {
      delete box()["x"];
    }, "deleting .x"));
  it("Object.defineProperty", () => denies(() => Object.defineProperty(box(), "x", { value: 1 }), "defining .x"));
  it("Object.getOwnPropertyDescriptor", () => denies(() => Object.getOwnPropertyDescriptor(box(), "x"), "reading .x"));
  it("Object.setPrototypeOf", () => denies(() => Object.setPrototypeOf(box(), null), "changing its prototype"));
});

describe("what still works", () => {
  it("console.log and util.inspect print only [Unknown]", () => {
    expect(inspect(box())).toBe("[Unknown]");
    expect(inspect({ port: box() })).toBe("{ port: [Unknown] }");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    console.log(box());
    expect(inspect(log.mock.calls[0]![0])).toBe("[Unknown]");
    log.mockRestore();
  });

  it("a promise can resolve to one, and it can be passed around and compared", async () => {
    const b = await Promise.resolve(env.get("SEAM_TEST_PORT"));
    expect(b === b).toBe(true);
    expect(typeof b).toBe("object");
  });

  it("decode reads the value inside", () => {
    expect(__decode(__b.int64, env.get("SEAM_TEST_PORT"))).toEqual({ ok: true, value: 8080n });
    expect(__decode(__b.string, env.get("SEAM_TEST_UNSET"))).toMatchObject({ ok: false, error: { expected: "string", actual: "undefined", rule: "type" } });
    const all = __decode(__b.object<{ SEAM_TEST_PORT: string }>({ SEAM_TEST_PORT: __b.string }), env.all());
    expect(all).toEqual({ ok: true, value: { SEAM_TEST_PORT: "8080" } });
  });

  it("env.all is a copy taken when it is called", () => {
    const snapshot = env.all();
    process.env["SEAM_TEST_PORT"] = "9090";
    expect(__decode(__b.object<{ SEAM_TEST_PORT: string }>({ SEAM_TEST_PORT: __b.string }), snapshot)).toMatchObject({ value: { SEAM_TEST_PORT: "8080" } });
    process.env["SEAM_TEST_PORT"] = "8080";
  });

  it("Unknown.log prints the contents, as the debugging exit", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    Unknown.log(env.get("SEAM_TEST_PORT"));
    expect(log).toHaveBeenCalledWith("8080");
    log.mockRestore();
  });
});

describe("the box shows nothing of the shape inside", () => {
  it("its then is nothing even when the contents have a then key, which is never read", async () => {
    const thenJson = join(dir, "then.json");
    writeFileSync(thenJson, '{"then": "not a function"}');
    const v = await file.readJson(thenJson);
    expect((v as unknown as { then: unknown }).then).toBeUndefined();
    // Awaiting it again doesn't treat the contents as a thenable either.
    expect(await Promise.resolve(v)).toBe(v);
    expect(__decode(__b.object<{ then: string }>({ then: __b.string }), v)).toEqual({ ok: true, value: { then: "not a function" } });
  });

  it("Array.isArray, the prototype and typeof are the same whatever is inside", async () => {
    const boxes = [env.get("SEAM_TEST_PORT"), env.get("SEAM_TEST_UNSET"), env.all(), await file.readJson(json)];
    writeFileSync(join(dir, "list.json"), "[1, 2, 3]");
    boxes.push(await file.readJson(join(dir, "list.json")));
    for (const b of boxes) {
      expect(Array.isArray(b)).toBe(false);
      expect(Object.getPrototypeOf(b)).toBe(Object.prototype);
      expect(typeof b).toBe("object");
      expect(b instanceof Array).toBe(false);
    }
  });
});

describe("files", () => {
  type Config = { name: string; ports: number[] };
  const Config = __b.object<Config>({ name: __b.string, ports: __b.array(__b.number) });

  it("readJson parses, and the result is boxed", async () => {
    const v = await file.readJson(json);
    denies(() => (v as unknown as Config).name, "reading .name");
    expect(__decode(Config, v)).toEqual({ ok: true, value: { name: "secret-name", ports: [1, 2] } });
  });

  it("readText gives the text, which decode … from json can parse", async () => {
    const t = await file.readText(json);
    denies(() => (t as unknown as string).length, "reading .length");
    expect(__decodeJson(Config, t)).toMatchObject({ ok: true });
    expect(__decodeJson(Config, await file.readText(broken))).toMatchObject({ ok: false, error: { rule: "json", actual: "malformed JSON" } });
  });

  it("readJson rejects malformed JSON naming the path, not the contents", async () => {
    await expect(file.readJson(broken)).rejects.toThrow(new SyntaxError(`${broken} is not valid JSON`));
    await expect(file.readJson(broken)).rejects.not.toThrow(/hunter2/);
  });

  it("a file that can't be read rejects as fs.readFile does", async () => {
    await expect(file.readText(join(dir, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
