import { parse as forkParse } from "@seamscript/parser";
import { describe, expect, it } from "vitest";

type AnyNode = { type: string; [key: string]: any };

function parse(source: string, jsx = false): AnyNode[] {
  const plugins: any[] = jsx ? ["jsx", "typescript", "seamscript"] : ["typescript", "seamscript"];
  return (forkParse(source, { sourceType: "module", plugins }) as any).program.body;
}

/** The AST without positions, for compact comparisons. */
function shape(node: unknown): unknown {
  return JSON.parse(
    JSON.stringify(node, (k, v) =>
      ["start", "end", "loc", "range", "extra", "leadingComments", "trailingComments", "innerComments"].includes(k)
        ? undefined
        : v,
    ),
  );
}

const expr = (source: string, jsx = false) => parse(`(${source});`, jsx)[0]!.expression;

describe("boundary", () => {
  it("parses an object boundary into a TS type literal", () => {
    const [decl] = parse("boundary Order { id: Int64, memo: Text<NFC>; tags?: string[] }");
    expect(decl!.type).toBe("SeamBoundaryDeclaration");
    expect(decl!.id.name).toBe("Order");
    expect(decl!.union).toBeNull();
    expect(decl!.body.type).toBe("TSTypeLiteral");
    expect(decl!.body.members.map((m: AnyNode) => [m.key.name, !!m.optional])).toEqual([
      ["id", false],
      ["memo", false],
      ["tags", true],
    ]);
  });

  it("parses a union boundary", () => {
    const [decl] = parse("boundary Event = Paid | Refunded;");
    expect(decl!.body).toBeNull();
    expect(shape(decl!.union)).toMatchObject({ type: "TSUnionType", types: [{ typeName: { name: "Paid" } }, { typeName: { name: "Refunded" } }] });
  });

  it("can be exported", () => {
    const [decl] = parse("export boundary Order { id: Int64 }");
    expect(decl!.type).toBe("ExportNamedDeclaration");
    expect(decl!.declaration.type).toBe("SeamBoundaryDeclaration");
  });

  it("declares a value and a type: clashes are reported", () => {
    expect(() => parse("boundary Order { id: Int64 }\nconst Order = 1;")).toThrow(/already been declared/);
    expect(() => parse("boundary Order { id: Int64 }\ntype Order = 1;")).toThrow(/already been declared/);
    expect(() => parse("export boundary A { a: string }\nexport const A = 1;")).toThrow();
  });
});

describe("decode", () => {
  it("parses the type and the operand", () => {
    expect(shape(expr("decode Order from await res.json()"))).toMatchObject({
      type: "SeamDecodeExpression",
      typeAnnotation: { type: "TSTypeReference", typeName: { name: "Order" } },
      argument: { type: "AwaitExpression" },
    });
  });

  it("accepts builtin types, arrays and nullable types as targets", () => {
    expect(shape(expr("decode Text<NFC>[] from v"))).toMatchObject({
      typeAnnotation: { type: "TSArrayType", elementType: { typeName: { name: "Text" } } },
    });
    expect(shape(expr("decode string | null from v"))).toMatchObject({
      typeAnnotation: { type: "TSUnionType" },
    });
  });

  it("accepts a target that starts with a literal", () => {
    expect(shape(expr(`decode "buy" | "sell" | null from v`))).toMatchObject({
      type: "SeamDecodeExpression",
      typeAnnotation: { type: "TSUnionType", types: [{ type: "TSLiteralType" }, { type: "TSLiteralType" }, { type: "TSNullKeyword" }] },
    });
    expect(shape(expr("decode 'a' from v"))).toMatchObject({ typeAnnotation: { type: "TSLiteralType" } });
    expect(shape(expr("decode 1 | 2 from v"))).toMatchObject({ typeAnnotation: { type: "TSUnionType" } });
  });

  it("binds like await: the operand is a unary expression", () => {
    expect(shape(expr("decode A from a ?? b"))).toMatchObject({
      type: "LogicalExpression",
      left: { type: "SeamDecodeExpression", argument: { name: "a" } },
    });
    expect(shape(expr("decode A from a.b().c"))).toMatchObject({
      type: "SeamDecodeExpression",
      argument: { type: "MemberExpression" },
    });
  });

  it("takes a parenthesized target when `from` follows on the same line", () => {
    expect(shape(expr("decode (Order | null)[] from v"))).toMatchObject({
      type: "SeamDecodeExpression",
      typeAnnotation: { type: "TSArrayType" },
      argument: { type: "Identifier", name: "v" },
    });
    expect(shape(expr("decode (string) from v"))).toMatchObject({ type: "SeamDecodeExpression" });
  });

  it("works inside JSX files", () => {
    expect(shape(expr("<p>{decode A from v}</p>", true))).toMatchObject({
      type: "JSXElement",
      children: [{ expression: { type: "SeamDecodeExpression" } }],
    });
  });
});

describe("latest", () => {
  it("wraps an async function declaration", () => {
    const [decl] = parse("latest async function search(q: string) { return 1; }");
    expect(decl!.type).toBe("SeamLatestDeclaration");
    expect(decl!.declaration).toMatchObject({ type: "FunctionDeclaration", async: true, id: { name: "search" } });
  });

  it("can be exported and is checked for duplicate exports", () => {
    const [decl] = parse("export latest async function search() {}");
    expect(decl!.declaration.type).toBe("SeamLatestDeclaration");
    expect(() => parse("export latest async function f() {}\nexport function f() {}")).toThrow();
  });
});

// Valid TypeScript that uses the words as identifiers must keep its meaning.
describe("the keywords remain identifiers everywhere else", () => {
  const plain = [
    "const decode = (x: unknown) => x; decode(1); decode<number>(1);",
    "decode as number;",
    "decode satisfies unknown;",
    "for (decode of xs) {}",
    "decode\nOrder\nfrom",
    "let boundary = 1; boundary++; boundary as any;",
    "boundary\nOrder\n{}",
    "latest\nasync function f() {}",
    "const latest = 1, async = 2; latest; async;",
    "decode ? a : b;",
    "decode`x`; decode - 1; decode\n\"a\";",
    // Calls: a parenthesis starts a decode target only when `from` follows on the line.
    "decode (x); decode (a, b) + 1; decode((a: string) => 1); decode (x)\nfrom(y);",
    "decode (x) ? from : y; const from = 1; decode (from);",
    "obj.decode; obj.boundary; obj.latest; ({ decode, boundary, latest });",
    "class C { decode() {} boundary = 1; latest() {} }",
    "type T = { decode: string; boundary: number };",
    "\\u0064ecode;",
  ];
  for (const source of plain) {
    it(JSON.stringify(source), () => {
      const asTs = forkParse(source, { sourceType: "module", plugins: ["typescript"] });
      const asSeam = forkParse(source, { sourceType: "module", plugins: ["typescript", "seamscript"] });
      expect(shape(asSeam)).toEqual(shape(asTs));
    });
  }

  it("requires `from` on the same line as the type", () => {
    expect(() => parse("const r = decode Order\nfrom v;")).toThrow();
  });
});

it("requires the typescript plugin", () => {
  expect(() => forkParse("", { plugins: ["seamscript"] })).toThrow(/requires the typescript plugin/);
});
