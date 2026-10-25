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

describe("boundary field constraints", () => {
  const constraints = (source: string) =>
    parse(source)[0]!.body.members.map((m: AnyNode) => shape(m.typeAnnotation.constraints ?? null));

  it("parses each constraint, several on one field", () => {
    const [n, s, t] = constraints("boundary P { n: number in 1..65_535, s: string matches /^[a-z\\/]+$/u, t: Text<NFC> minLength 1 maxLength 40 }");
    expect(n).toEqual([{ type: "SeamConstraint", kind: "in", min: "1", max: "65_535" }]);
    expect(s).toEqual([{ type: "SeamConstraint", kind: "matches", pattern: { type: "RegExpLiteral", pattern: "^[a-z\\/]+$", flags: "u" } }]);
    expect(t).toEqual([
      { type: "SeamConstraint", kind: "minLength", value: 1 },
      { type: "SeamConstraint", kind: "maxLength", value: 40 },
    ]);
  });

  it("reads a range with negative and fractional bounds and spaces", () => {
    expect(constraints("boundary P { x: number in - 5 .. 0.5 }")[0]).toEqual([{ type: "SeamConstraint", kind: "in", min: "-5", max: "0.5" }]);
  });

  it("ends the field's range where the constraints end", () => {
    const [decl] = parse("boundary P { n: number in 1..9, m: number }");
    const [n] = decl!.body.members;
    expect(n.typeAnnotation.constraints[0].end).toBe("boundary P { n: number in 1..9".length);
    expect(n.typeAnnotation.typeAnnotation.end).toBe("boundary P { n: number".length);
  });

  it("takes a constraint on the next line, but not a member named like one", () => {
    expect(constraints("boundary P {\n  a: string\n    matches /x/\n}")[0]).toHaveLength(1);
    const members = parse("boundary P {\n  a: number\n  minLength: number\n  maxLength?: string\n  in: boolean\n}")[0]!.body.members;
    expect(members.map((m: AnyNode) => m.key.name)).toEqual(["a", "minLength", "maxLength", "in"]);
    expect(members.every((m: AnyNode) => m.typeAnnotation.constraints === undefined)).toBe(true);
  });

  it("leaves nested annotations alone", () => {
    expect(() => parse("boundary P { f: (x: string matches /a/) => void }")).toThrow();
    expect(constraints("boundary P { f: (x: string) => void }")[0]).toBeNull();
  });

  it("reports a malformed constraint", () => {
    expect(() => parse("boundary P { n: number in 1.. }")).toThrow(/a range such as 1\.\.100/);
    expect(() => parse("boundary P { s: string matches 3 }")).toThrow(/a regular expression literal/);
    expect(() => parse("boundary P { s: Text<NFC> maxLength x }")).toThrow(/a number/);
  });

  it("follows the type of an alias boundary", () => {
    const [decl] = parse("boundary Chunk = Pcm<Int16, 16000, 1> minLength 160 maxLength 3200;\nconst x = 1;");
    expect(decl!.union.type).toBe("TSTypeReference");
    expect(shape(decl!.constraints)).toEqual([
      { type: "SeamConstraint", kind: "minLength", value: 160 },
      { type: "SeamConstraint", kind: "maxLength", value: 3200 },
    ]);
    expect(decl!.end).toBe("boundary Chunk = Pcm<Int16, 16000, 1> minLength 160 maxLength 3200;".length);
    const [plain] = parse("boundary Event = Paid | Refunded");
    expect(plain!.constraints).toBeUndefined();
  });

  it("is not part of TypeScript type literals elsewhere", () => {
    expect(() => parse("type P = { s: string matches /x/ }")).toThrow();
    expect(() => parse("interface P { n: number in 1..2 }")).toThrow();
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

  it("parses `from json`: the operand is JSON text", () => {
    expect(shape(expr("decode Order from json text"))).toMatchObject({
      type: "SeamDecodeExpression",
      json: true,
      argument: { type: "Identifier", name: "text" },
    });
    expect(shape(expr("decode Order from json await res.text()"))).toMatchObject({ json: true, argument: { type: "AwaitExpression" } });
    expect(shape(expr("decode Order from json localStorage.getItem('k') ?? d"))).toMatchObject({
      type: "LogicalExpression",
      left: { json: true, argument: { type: "CallExpression" } },
    });
    expect(shape(expr("decode Order from json '[1]'"))).toMatchObject({ json: true, argument: { type: "StringLiteral" } });
  });

  it("keeps a variable named json the operand", () => {
    for (const operand of ["json", "json(x)", "json.body", "json[0]", "json`x`", "json ?? x", "json as T"]) {
      const node = shape(expr(`decode Order from ${operand}`)) as AnyNode;
      const decode = node.type === "SeamDecodeExpression" ? node : (node.left ?? node.expression);
      expect(decode.json, operand).toBe(false);
    }
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
