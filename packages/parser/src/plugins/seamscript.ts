// SeamScript syntax. Not part of upstream Babel; this file and the few lines that
// register it in plugin-utils.ts are the whole fork (see ../../UPSTREAM.md).
//
//   boundary Order { id: Int64, memo: Text<NFC> }      SeamBoundaryDeclaration (body)
//   boundary Event = Paid | Refunded                   SeamBoundaryDeclaration (union)
//   decode Order from await res.json()                 SeamDecodeExpression
//   latest async function search(q) { ... }           SeamLatestDeclaration
//
// Each construct starts with an ordinary identifier, so it is recognized only in
// shapes that are syntax errors in TypeScript: the keyword followed, on the same
// line, by another name. Otherwise `boundary`, `decode` and `latest` stay plain
// identifiers, which keeps every valid TypeScript program parsing exactly as before.

import type Parser from "../parser/index.ts";
import { tt } from "../tokenizer/types.ts";
import type * as N from "../types.ts";
import type { Undone } from "../parser/node.ts";
import { BindingFlag } from "../util/scopeflags.ts";
import type { ExpressionErrors } from "../parser/util.ts";

// Words that may follow an identifier in valid TypeScript on the same line
// (`x as T`, `x satisfies T`, `for (x of xs)`); a construct never starts this way.
const CONTINUATIONS = ["as", "satisfies", "of"];

export default (superClass: typeof Parser) =>
  // The typescript mixin is always applied first (see validatePlugins), so its
  // ts* methods exist at runtime even though `typeof Parser` does not declare them.
  class SeamScriptParserMixin extends (superClass as any) {
    seamAtWord(word: string): boolean {
      return (
        this.state.type === tt.name &&
        this.state.value === word &&
        !this.state.containsEsc
      );
    }

    /** The next token is a name on the current line and does not continue an expression. */
    seamNextIsNameOnSameLine(): boolean {
      const next = this.nextTokenInLineStart();
      if (!this.chStartsBindingIdentifier(this.codePointAtPos(next), next)) {
        return false;
      }
      return !CONTINUATIONS.some(w => this.isUnparsedContextual(next, w));
    }

    seamIsBoundaryStart(): boolean {
      return this.seamAtWord("boundary") && this.seamNextIsNameOnSameLine();
    }

    seamIsLatestStart(): boolean {
      if (!this.seamAtWord("latest")) return false;
      const next = this.nextTokenInLineStart();
      if (!this.isUnparsedContextual(next, "async")) return false;
      const after = this.nextTokenInLineStartSince(next + "async".length);
      return this.isUnparsedContextual(after, "function");
    }

    seamParseDeclaration(): N.Node | undefined {
      if (this.seamIsBoundaryStart()) return this.seamParseBoundary();
      if (this.seamIsLatestStart()) return this.seamParseLatest();
      return undefined;
    }

    // boundary Name { members }  |  boundary Name = A | B ;
    seamParseBoundary(): N.Node {
      const node = this.startNode() as Undone<any>;
      this.next(); // eat 'boundary'
      node.id = this.parseIdentifier();
      // A boundary declares both a type and a value of the same name.
      this.checkIdentifier(node.id, BindingFlag.TYPE_LEXICAL);
      this.checkIdentifier(node.id, BindingFlag.TYPE_TS_TYPE);
      if (this.match(tt.eq)) {
        node.body = null;
        node.union = this.tsInType(() => {
          this.expect(tt.eq);
          return this.tsParseType();
        });
        this.semicolon();
      } else {
        node.union = null;
        node.body = this.tsInType(() => this.tsParseTypeLiteral());
      }
      return this.finishNode(node, "SeamBoundaryDeclaration");
    }

    // latest async function name(...) { ... }
    seamParseLatest(): N.Node {
      const node = this.startNode() as Undone<any>;
      this.next(); // eat 'latest'
      const fn = this.startNode() as Undone<N.FunctionDeclaration>;
      this.next(); // eat 'async'
      node.declaration = this.parseFunctionStatement(fn, true, false);
      return this.finishNode(node, "SeamLatestDeclaration");
    }

    // decode Type from UnaryExpression
    // Same precedence as `await`: `decode X from a ?? b` is `(decode X from a) ?? b`.
    seamTryParseDecode(): N.Expression | undefined {
      if (!this.seamAtWord("decode") || !this.seamNextIsNameOnSameLine()) {
        return undefined;
      }
      const node = this.startNode() as Undone<any>;
      const type = this.tsTryParseAndCatch(() => {
        const t = this.tsInType(() => {
          this.next(); // eat 'decode'
          return this.tsParseType();
        });
        if (!this.isContextual(tt._from) || this.hasPrecedingLineBreak()) {
          this.unexpected();
        }
        return t;
      });
      if (!type) return undefined;
      this.next(); // eat 'from'
      node.typeAnnotation = type;
      node.argument = this.parseMaybeUnary(null, true);
      return this.finishNode(node, "SeamDecodeExpression");
    }

    // ======================================================
    // OVERRIDES
    // ======================================================

    parseStatementContent(flags: number, decorators: N.Decorator[] | null) {
      return (
        this.seamParseDeclaration() ??
        super.parseStatementContent(flags, decorators)
      );
    }

    shouldParseExportDeclaration(): boolean {
      return (
        this.seamIsBoundaryStart() ||
        this.seamIsLatestStart() ||
        super.shouldParseExportDeclaration()
      );
    }

    parseExportDeclaration(node: N.ExportNamedDeclaration) {
      return this.seamParseDeclaration() ?? super.parseExportDeclaration(node);
    }

    checkNamedExport(node: Undone<N.ExportNamedDeclaration>, isFrom?: boolean) {
      const decl = node.declaration as any;
      if (decl?.type === "SeamBoundaryDeclaration") {
        this.checkDuplicateExports(node, decl.id.name);
      } else if (decl?.type === "SeamLatestDeclaration") {
        this.checkDuplicateExports(node, decl.declaration.id.name);
      } else {
        super.checkNamedExport(node, isFrom);
      }
    }

    parseMaybeUnary(
      refExpressionErrors?: ExpressionErrors | null,
      sawUnary?: boolean,
    ): N.Expression {
      return (
        this.seamTryParseDecode() ??
        super.parseMaybeUnary(refExpressionErrors, sawUnary)
      );
    }
  } as unknown as typeof Parser;
