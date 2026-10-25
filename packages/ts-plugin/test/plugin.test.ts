// The plugin as an editor uses it: a real tsserver loads it from the project's
// tsconfig.json and is driven over its protocol.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, type Position, TsServer } from "./tsserver.js";

interface Diag {
  start: Position;
  end: Position;
  text: string;
  code: number;
  source?: string;
}
interface Span {
  file: string;
  start: Position;
  end: Position;
}

// A copy of the fixture inside the package, so @seamscript/runtime and the plugin
// resolve from the repository's node_modules; tests add and edit files in it.
const root = mkdtempSync(join(import.meta.dirname, ".tmp-"));
cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });
const src = (name: string) => join(root, "src", name);
const api = src("api.seam.ts");
const use = src("use.seam.ts");
const apiText = readFileSync(api, "utf8");
const useText = readFileSync(use, "utf8");

let server: TsServer;
beforeAll(async () => {
  server = new TsServer();
  await server.open(api);
  await server.open(use);
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const semantic = (file: string) => server.request<Diag[]>("semanticDiagnosticsSync", { file });
const syntactic = (file: string) => server.request<Diag[]>("syntacticDiagnosticsSync", { file });
const codes = (ds: Diag[]) => ds.map((d) => `${d.source === "seamscript" ? "SEAM" : "TS"}${d.code}@${d.start.line}`);
const quickInfo = (file: string, p: Position) => server.request<{ displayString: string }>("quickinfo", { file, ...p }).then((r) => r.displayString);
const completions = (file: string, p: Position) =>
  server.request<{ entries: { name: string }[] } | undefined>("completionInfo", { file, ...p }).then((r) => r?.entries.map((e) => e.name) ?? []);

/** Opens a new file in the project with `text`, written to disk first as an editor's save would be. */
async function openNew(name: string, text: string): Promise<string> {
  const file = src(name);
  writeFileSync(file, text);
  await server.open(file, text);
  return file;
}

describe("a project of .seam.ts files", () => {
  it("reports TypeScript's errors and SeamScript's checks where they are", async () => {
    // JSON.parse is outside data: Unknown, so it cannot be asserted or assigned to string.
    expect(codes(await semantic(use)).sort()).toEqual(["SEAM2001@7", "TS2322@8", "TS2352@7"]);
    expect(await semantic(api)).toEqual([]);
    expect(await syntactic(api)).toEqual([]);
  });

  it("shows types through boundaries, decode and outside data", async () => {
    expect(await quickInfo(use, at(useText, "r.value.memo", 2))).toBe("(property) value: Order");
    expect(await quickInfo(use, at(useText, "raw ="))).toBe("const raw: Unknown");
    expect(await quickInfo(api, at(apiText, "memo"))).toBe('(property) memo: Text<"NFC">');
  });

  it("completes a boundary's fields", async () => {
    expect(await completions(use, at(useText, "r.value.memo", 8))).toEqual(expect.arrayContaining(["id", "memo", "parent", "total"]));
  });

  it("goes to a boundary's declaration from a value use and from a decode target", async () => {
    const boundaryName = { file: api, start: at(apiText, "Order {"), end: at(apiText, "Order {", 5) };
    expect(await server.request<Span[]>("definition", { file: use, ...at(useText, "Order.encode") })).toEqual([boundaryName]);
    expect(await server.request<Span[]>("definition", { file: api, ...at(apiText, "decode Order", 8) })).toEqual([boundaryName]);
  });

  it("renames a boundary everywhere, including decode targets and other files", async () => {
    const r = await server.request<{ locs: { file: string; locs: { start: Position }[] }[] }>("rename", { file: api, ...at(apiText, "Order {") });
    const where = r.locs.flatMap((f) => f.locs.map((l) => `${f.file === api ? "api" : "use"}:${l.start.line}:${l.start.offset}`)).sort();
    expect(where).toEqual(
      [
        `api:${at(apiText, "Order {").line}:${at(apiText, "Order {").offset}`,
        `api:${at(apiText, "Order | null").line}:${at(apiText, "Order | null").offset}`,
        `api:${at(apiText, "Order, DecodeError").line}:${at(apiText, "Order, DecodeError").offset}`,
        `api:${at(apiText, "decode Order", 7).line}:${at(apiText, "decode Order", 7).offset}`,
        `use:${at(useText, "Order }").line}:${at(useText, "Order }").offset}`,
        `use:${at(useText, "Order.encode").line}:${at(useText, "Order.encode").offset}`,
      ].sort(),
    );
  });

  it("finds a latest function's declaration from its uses", async () => {
    const name = { file: api, start: at(apiText, "load("), end: at(apiText, "load(", 4) };
    expect(await server.request<Span[]>("definition", { file: use, ...at(useText, "load(id)") })).toEqual([name]);
    const refs = await server.request<{ refs: Span[] }>("references", { file: use, ...at(useText, "load(id)") });
    expect(refs.refs.map(({ file, start, end }) => ({ file, start, end }))).toContainEqual(name);
  });
});

describe("SeamScript's own diagnostics", () => {
  it("reports a field type that cannot cross a boundary, and UTF-16 access on Text", async () => {
    const text = [
      "export boundary Note {",
      "  body: Text<NFC>;",
      "  onSave: () => void;",
      "}",
      "export const n = (note: Note) => note.body.length;",
      "",
    ].join("\n");
    const file = await openNew("note.seam.ts", text);
    expect(codes(await semantic(file)).sort()).toEqual(["SEAM1101@3", "SEAM2101@5"]);
  });

  it("treats an AudioWorklet's inputs as outside data to decode, and checks audio boundaries", async () => {
    const text = [
      "declare class AudioWorkletProcessor { readonly port: MessagePort; }",
      "boundary Quantum = Planar<Float32, 1> maxLength 128",
      "boundary Chunk = Pcm<Int24, 16000, 1>",
      "export class Capture extends AudioWorkletProcessor {",
      "  process(inputs: Float32Array[][]) {",
      "    const raw: Float32Array[] = inputs[0]!;",
      "    const q = decode Quantum from inputs[0];",
      "    if (q.ok) this.port.postMessage(q.value.channels[0].slice());",
      "    return raw.length > 0;",
      "  }",
      "}",
      "",
    ].join("\n");
    const file = await openNew("capture.seam.ts", text);
    expect(codes(await semantic(file)).sort()).toEqual(["SEAM1302@3", "TS2304@3", "TS2740@6"]);
  });
});

describe("editing", () => {
  it("keeps completion and types while the file does not parse", async () => {
    const text = useText.replace("  return Text.length", "  const draft = r.value.\n  return Text.length");
    const file = await openNew("draft.seam.ts", useText);
    await server.request("semanticDiagnosticsSync", { file }); // settle the wraps first
    const p = at(useText, "  return Text.length");
    await server.change(file, p, p, "  const draft = r.value.\n");
    const dot = at(text, "draft = r.value.", "draft = r.value.".length);
    expect(await completions(file, dot)).toEqual(expect.arrayContaining(["id", "memo", "parent", "total"]));
    // TypeScript's own error for the incomplete line, not a cascade from SeamScript syntax.
    expect(codes(await syntactic(file))).toEqual([`TS1003@${dot.line}`]);
    // The rest of the file is still checked, outside data included.
    expect(await quickInfo(file, at(text, "raw ="))).toBe("const raw: Unknown");
  });

  it("reports syntax errors that only SeamScript's parser sees", async () => {
    const text = 'import { Order } from "./api.seam";\nexport const r = (v: Unknown) => decode Order from v;\n';
    const file = await openNew("syntax.seam.ts", text);
    await server.request("semanticDiagnosticsSync", { file });
    // A redeclaration is a syntax error to Babel, but only a type error (TS2451) to TypeScript.
    const end = at(text, "from v;", "from v;".length);
    await server.change(file, end, end, "\nconst r = 2;");
    expect(codes(await syntactic(file))).toEqual([`SEAM1000@${end.line + 1}`]);
  });

  it("does not show TypeScript's errors on SeamScript syntax in a file that never parsed", async () => {
    const file = await openNew("broken.seam.ts", "export boundary Draft {\n  id: Int64;\n");
    expect(codes(await syntactic(file)).map((c) => c.split("@")[0])).toEqual(["SEAM1000"]);
    expect(await semantic(file)).toEqual([]);
    // Once it parses, it is checked as usual.
    await server.change(file, { line: 3, offset: 1 }, { line: 3, offset: 1 }, "}\n");
    expect(await syntactic(file)).toEqual([]);
    expect(await semantic(file)).toEqual([]);
  });
});

describe("quick fixes", () => {
  interface Protocol {
    description: string;
    changes: { fileName: string; textChanges: { start: Position; end: Position; newText: string }[] }[];
  }

  /** Applies a fix's edits (1-based line/offset) to `text`, last first. */
  function apply(text: string, fix: Protocol): string {
    const lines = text.split("\n");
    const offset = (p: Position) => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.offset - 1;
    const edits = fix.changes.flatMap((c) => c.textChanges).sort((a, b) => offset(b.start) - offset(a.start));
    for (const e of edits) text = text.slice(0, offset(e.start)) + e.newText + text.slice(offset(e.end));
    return text;
  }

  /** The SeamScript diagnostics of `file` with their fixes, in reported order. */
  async function fixesOf(file: string) {
    // In source order (TypeScript's own errors come first otherwise), so fixes can be applied from the end.
    const ds = (await semantic(file))
      .filter((d) => d.source === "seamscript" || [2322, 2739, 2740, 2741].includes(d.code))
      .sort((a, b) => a.start.line - b.start.line || a.start.offset - b.start.offset);
    return Promise.all(
      ds.map(async (d) => {
        const all = await server.request<Protocol[]>("getCodeFixes", { file, startLine: d.start.line, startOffset: d.start.offset, endLine: d.end.line, endOffset: d.end.offset, errorCodes: [d.code] });
        return { code: d.source === "seamscript" ? `SEAM${d.code}` : "TS-assignment", fixes: all.filter((f) => f.changes.length > 0 && !f.description.startsWith("Add ")) };
      }),
    );
  }

  it("lists SeamScript's fixable codes as supported", async () => {
    const supported = await server.request<string[]>("getSupportedCodeFixes", { file: use });
    expect(supported).toEqual(expect.arrayContaining(["2001", "2101", "2201"]));
  });

  it("offers a fix for each mechanical case, and the fixed file checks clean", async () => {
    const text = [
      'import { Order } from "./api.seam";',
      "export function f(o: Order, orders: Order[], text: string) {",
      "  const memo = o.memo;",
      "  const n = memo.length;",
      "  const first = memo[0];",
      "  const body = JSON.stringify(o) + JSON.stringify(orders);",
      "  const saved: Order = JSON.parse(text);",
      "  return [n, first, body, saved];",
      "}",
      "",
    ].join("\n");
    const file = await openNew("fixes.seam.ts", text);
    const found = await fixesOf(file);
    expect(found.map((f) => [f.code, f.fixes.map((x) => x.description)])).toEqual([
      ["SEAM2101", ["Use Text.length(memo)"]],
      ["SEAM2101", ["Use Text.at(memo, 0)"]],
      ["SEAM2201", ["Encode with Order.encode"]],
      ["SEAM2201", ["Encode with Order.encode"]],
      ["TS-assignment", ["Decode as Order (saved becomes a Result to check)"]],
    ]);
    let fixed = text;
    // Applied one at a time from the end, so earlier positions stay valid.
    for (const f of [...found].reverse()) fixed = apply(fixed, f.fixes[0]!);
    expect(fixed).toContain("const n = Text.length(memo);");
    expect(fixed).toContain("const first = Text.at(memo, 0);");
    expect(fixed).toContain("JSON.stringify(Order.encode(o)) + JSON.stringify(orders.map(Order.encode))");
    expect(fixed).toContain("const saved = decode Order from JSON.parse(text);");
    await server.change(file, { line: 1, offset: 1 }, { line: text.split("\n").length, offset: 1 }, fixed);
    expect(codes(await semantic(file))).toEqual([]);
  });

  it("offers no fix where an edit would change the meaning", async () => {
    // `decode T from a ?? b` decodes only `a`, so `const x: T = a ?? b` gets no fix.
    const file = await openNew("nofix.seam.ts", 'import { Order } from "./api.seam";\nexport const x: Order = JSON.parse("{}") ?? null;\n');
    const found = await fixesOf(file);
    expect(found.map((f) => f.code)).toEqual(["TS-assignment"]);
    expect(found[0]!.fixes).toEqual([]);
  });
});
