import { parse as babelParse } from "@seamscript/parser";
import type * as t from "@babel/types";

// @babel/types does not export its BaseNode; this is the same shape.
type BaseNode = Pick<t.Identifier, "start" | "end" | "loc" | "range" | "extra" | "leadingComments" | "trailingComments" | "innerComments">;

/** `boundary Name { ... }` (body) or `boundary Name = A | B` (union). */
export interface SeamBoundaryDeclaration extends BaseNode {
  type: "SeamBoundaryDeclaration";
  id: t.Identifier;
  body: t.TSTypeLiteral | null;
  union: t.TSType | null;
  /** After the type of `boundary Name = Type` (an alias of a field type). */
  constraints?: SeamConstraint[];
}

/**
 * A constraint after a boundary field's type, kept on its TSTypeAnnotation as
 * `constraints`: `matches /re/`, `minLength N`, `maxLength N`, `in A..B`.
 */
export interface SeamConstraint extends BaseNode {
  type: "SeamConstraint";
  kind: "matches" | "minLength" | "maxLength" | "in";
  /** matches */
  pattern?: t.RegExpLiteral;
  /** minLength, maxLength */
  value?: number;
  /** in: the bounds as written, without spaces (`-5`, `65_535`). */
  min?: string;
  max?: string;
}

/** A boundary field's annotation, with the constraints that follow its type. */
export type FieldAnnotation = t.TSTypeAnnotation & { constraints?: SeamConstraint[] };

/** `decode Type from argument`, or `decode Type from json argument` (json: true). */
export interface SeamDecodeExpression extends BaseNode {
  type: "SeamDecodeExpression";
  typeAnnotation: t.TSType;
  argument: t.Expression;
  json: boolean;
}

/** `latest async function name(...) { ... }` */
export interface SeamLatestDeclaration extends BaseNode {
  type: "SeamLatestDeclaration";
  declaration: t.FunctionDeclaration;
}

export type SeamNode = SeamBoundaryDeclaration | SeamDecodeExpression | SeamLatestDeclaration | SeamConstraint;
export type AnyNode = t.Node | SeamNode;

/** Positions are always present on nodes produced by the parser. */
export const start = (n: AnyNode): number => n.start!;
export const end = (n: AnyNode): number => n.end!;

export function parse(source: string, jsx: boolean): t.File {
  return babelParse(source, {
    sourceType: "module",
    plugins: jsx ? ["jsx", "typescript", "seamscript"] : ["typescript", "seamscript"],
    // The transform edits text by position; comments stay in place without being
    // attached to nodes, which is a measurable part of parsing.
    attachComment: false,
  }) as unknown as t.File;
}

const SKIP = new Set(["loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors"]);

export type Visitor = (node: AnyNode, parent: AnyNode | null, grandparent: AnyNode | null) => boolean | void;

/** Depth-first walk over every node. Returning `false` skips the node's children. */
export function walk(root: AnyNode, visit: Visitor): void {
  const go = (node: AnyNode, parent: AnyNode | null, grandparent: AnyNode | null) => {
    if (visit(node, parent, grandparent) === false) return;
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) go(child, node, parent);
      } else if (isNode(value)) {
        go(value, node, parent);
      }
    }
  };
  go(root, null, null);
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
