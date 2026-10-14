// The injection grammar with VS Code's tokenizer (vscode-textmate, oniguruma) and
// the TypeScript grammars VS Code ships (via tm-grammars).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import oniguruma from "vscode-oniguruma";
import textmate from "vscode-textmate";

const require = createRequire(import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const grammars: Record<string, unknown> = {
  "source.ts": json(require.resolve("tm-grammars/grammars/typescript.json")),
  "source.tsx": json(require.resolve("tm-grammars/grammars/tsx.json")),
  "seamscript.injection": json(new URL("../syntaxes/seamscript.injection.json", import.meta.url).pathname),
};

let registry: textmate.Registry;
beforeAll(async () => {
  await oniguruma.loadWASM(readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer);
  registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
    loadGrammar: async (scope) => (grammars[scope] ? textmate.parseRawGrammar(JSON.stringify(grammars[scope]), `${scope}.json`) : null),
    getInjections: (scope) => (scope === "source.ts" || scope === "source.tsx" ? ["seamscript.injection"] : undefined),
  });
});

/** Each token's text with the innermost scope that is not the language's own. */
async function tokens(code: string, scope = "source.ts"): Promise<[string, string][]> {
  const grammar = (await registry.loadGrammar(scope))!;
  let state = textmate.INITIAL;
  const out: [string, string][] = [];
  for (const line of code.split("\n")) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) {
      const text = line.slice(t.startIndex, t.endIndex);
      if (text.trim() !== "") out.push([text, t.scopes.at(-1)!]);
    }
    state = r.ruleStack;
  }
  return out;
}

const scopeOf = async (code: string, text: string, scope?: string) => (await tokens(code, scope)).find(([t]) => t === text)?.[1];

describe("boundary", () => {
  it("colors the keyword, the name and the body as a type", async () => {
    const code = "export boundary Order {\n  id: Int64;\n  memo: Text<NFC>;\n}\nconst x = 1;";
    expect(await scopeOf(code, "boundary")).toBe("storage.type.boundary.seamscript");
    expect(await scopeOf(code, "Order")).toBe("entity.name.type.boundary.seamscript");
    expect(await scopeOf(code, "Int64")).toBe("entity.name.type.ts");
    expect(await scopeOf(code, "id")).toBe("variable.object.property.ts");
    // The declaration ends with its body.
    expect(await scopeOf(code, "const")).toBe("storage.type.ts");
  });

  it("colors a union boundary", async () => {
    const code = "export boundary Event = Hello | Tick\nlet y = 2;";
    expect(await scopeOf(code, "boundary")).toBe("storage.type.boundary.seamscript");
    expect(await scopeOf(code, "Tick")).toBe("entity.name.type.ts");
    expect(await scopeOf(code, "let")).toBe("storage.type.ts");
  });

  it("leaves a variable named boundary alone", async () => {
    expect(await scopeOf("const boundary = 1; boundary.x;", "boundary")).not.toMatch(/seamscript/);
  });
});

describe("decode", () => {
  it("colors decode … from and the target as a type", async () => {
    const code = "const r = decode Order[] from await res.json();";
    expect(await scopeOf(code, "decode")).toBe("keyword.operator.expression.decode.seamscript");
    expect(await scopeOf(code, "from")).toBe("keyword.operator.expression.from.seamscript");
    expect(await scopeOf(code, "Order")).toBe("entity.name.type.ts");
    expect(await scopeOf(code, "res")).toBe("variable.other.object.ts");
  });

  it("colors literal targets and works in .tsx", async () => {
    const code = 'const m = decode "frame" | "each" | null from q.get("render");';
    expect(await scopeOf(code, "decode", "source.tsx")).toBe("keyword.operator.expression.decode.seamscript");
    expect(await scopeOf(code, "from", "source.tsx")).toBe("keyword.operator.expression.from.seamscript");
  });

  it("colors a parenthesized target only when from follows", async () => {
    const code = "const a = decode (Order | null)[] from v;";
    expect(await scopeOf(code, "decode")).toBe("keyword.operator.expression.decode.seamscript");
    expect(await scopeOf(code, "from")).toBe("keyword.operator.expression.from.seamscript");
    expect(await scopeOf("decode (x) + 1;", "decode")).not.toMatch(/seamscript/);
  });

  it("leaves TypeScript's uses of the word alone", async () => {
    for (const code of ["decode(x);", "decode (x);", "const decode = f;", "decode as T;", "x.decode(y);", "for (const decode of xs) {}"]) {
      expect(await scopeOf(code, "decode"), code).not.toMatch(/seamscript/);
    }
    // `from` in an import is TypeScript's.
    expect(await scopeOf('import { a } from "b";', "from")).toBe("keyword.control.from.ts");
  });

  it("does not run past the end of the line when from is missing", async () => {
    expect(await scopeOf("const r = decode Order\nconst y = 1;", "const", undefined)).toBe("storage.type.ts");
    const second = (await tokens("const r = decode Order\nconst y = 1;")).filter(([t]) => t === "const")[1]?.[1];
    expect(second).toBe("storage.type.ts");
  });
});

describe("latest", () => {
  it("colors the modifier of a latest function", async () => {
    const code = "export latest async function search(q: string) {}";
    expect(await scopeOf(code, "latest")).toBe("storage.modifier.latest.seamscript");
    expect(await scopeOf(code, "search")).toBe("entity.name.function.ts");
    expect(await scopeOf("const latest = 1;", "latest")).not.toMatch(/seamscript/);
  });
});
