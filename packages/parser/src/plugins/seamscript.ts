// SeamScript syntax. Not part of upstream Babel; this file and the few lines that
// register it in plugin-utils.ts are the whole fork (see ../../UPSTREAM.md).
//
//   boundary Order { id: Int64, memo: Text<NFC> }      SeamBoundaryDeclaration (body)
//   boundary Event = Paid | Refunded                   SeamBoundaryDeclaration (union)
//   boundary Chunk = Pcm<Int16, 16000, 1> maxLength 3200   (union, with constraints)
//   boundary Port { n: number in 1..65535 }            SeamConstraint (on the field's TSTypeAnnotation)
//   decode Order from await res.json()                 SeamDecodeExpression
//   decode Order from json text                        SeamDecodeExpression (json: true)
//   latest async function search(q) { ... }           SeamLatestDeclaration
//
// Each construct starts with an ordinary identifier, so it is recognized only in
// shapes that are syntax errors in TypeScript: the keyword followed, on the same
// line, by another name. Otherwise `boundary`, `decode` and `latest` stay plain
// identifiers, which keeps every valid TypeScript program parsing exactly as before.

import type Parser from "../parser/index.ts";
import { tt } from "../tokenizer/types.ts";
import * as charCodes from "charcodes";
import type * as N from "../types.ts";
import type { Undone } from "../parser/node.ts";
import { BindingFlag } from "../util/scopeflags.ts";
import { createPositionWithColumnOffset } from "../util/location.ts";
import { Errors } from "../parse-error.ts";
import type { ExpressionErrors } from "../parser/util.ts";

// Words that may follow an identifier in valid TypeScript on the same line
// (`x as T`, `x satisfies T`, `for (x of xs)`); a construct never starts this way.
const CONTINUATIONS = ["as", "satisfies", "of"];

// Words that follow a boundary field's type to constrain its value.
const CONSTRAINT_WORDS = ["matches", "minLength", "maxLength"];

// After `in`: a range of two number literals, `1..65535`, `-0.5..0.5`. Scanned
// from the source: the tokenizer would read `1..65535` as `1.` and `.65535`.
const NUMBER = String.raw`-?[ \t]*\d(?:_?\d)*(?:\.\d(?:_?\d)*)?`;
const RANGE = new RegExp(String.raw`[ \t]*(${NUMBER})[ \t]*\.\.[ \t]*(${NUMBER})`, "y");

// A line that starts with one of these after a constraint word is a member named
// like the word (`minLength: number`), not a constraint.
const MEMBER_FOLLOWERS = new Set([":", "?", "(", "<", ",", ";", "}"]);

export default (superClass: typeof Parser) =>
  // The typescript mixin is always applied first (see validatePlugins), so its
  // ts* methods exist at runtime even though `typeof Parser` does not declare them.
  class SeamScriptParserMixin extends (superClass as any) {
    /** True while parsing the type annotation of a boundary's own field (not of anything nested in it). */
    seamFieldAnnotation = false;

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

    /**
     * The next token can start a decode target: a name, a string or number literal
     * (`decode "buy" | "sell" from v`), or a parenthesized type
     * (`decode (Order | null)[] from v`). An identifier followed on the same line by
     * a name, a string or a number is a syntax error in TypeScript; a template
     * literal is not (decode`x` is a tagged template), so it does not count. A
     * parenthesis is a call in TypeScript: it is taken for a decode only if a type
     * parses there and `from` follows on the same line, which a call never has
     * (seamTryParseDecode backtracks otherwise).
     */
    seamNextStartsDecodeTarget(): boolean {
      if (this.seamNextIsNameOnSameLine()) return true;
      const ch = this.codePointAtPos(this.nextTokenInLineStart());
      return ch === 0x22 || ch === 0x27 || ch === 0x28 || (ch >= 0x30 && ch <= 0x39);
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
        // `boundary Chunk = Pcm<Int16, 16000, 1> maxLength 3200`
        const constraints = this.seamParseConstraints();
        if (constraints.length > 0) node.constraints = constraints;
        this.semicolon();
      } else {
        node.union = null;
        const outer = this.seamFieldAnnotation;
        this.seamFieldAnnotation = true;
        try {
          node.body = this.tsInType(() => this.tsParseTypeLiteral());
        } finally {
          this.seamFieldAnnotation = outer;
        }
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
      if (!this.seamAtWord("decode") || !this.seamNextStartsDecodeTarget()) {
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
      node.json = this.seamAtWord("json") && this.seamNextStartsJsonText();
      if (node.json) this.next(); // eat 'json'
      node.argument = this.parseMaybeUnary(null, true);
      return this.finishNode(node, "SeamDecodeExpression");
    }

    /**
     * After `from`, `json` marks the operand as JSON text to parse first
     * (`decode Order from json text`) only when what follows on the same line is a
     * name or a string, which would be a syntax error after a plain `json`. A call
     * `json(x)`, a member `json.body`, an index `json[0]` and a tagged template
     * json`x` keep `json` the operand itself.
     */
    seamNextStartsJsonText(): boolean {
      const next = this.nextTokenInLineStart();
      const ch = this.codePointAtPos(next);
      if (ch === charCodes.quotationMark || ch === charCodes.apostrophe) return true;
      return this.chStartsBindingIdentifier(ch, next) && !CONTINUATIONS.some(w => this.isUnparsedContextual(next, w));
    }

    /**
     * Constraints after a boundary field's type, any number of them:
     * `matches /re/`, `minLength N`, `maxLength N`, `in A..B`. On a new line, a word
     * followed by `:`, `?`, `(`, `<`, `,`, `;` or `}` starts the next member instead.
     */
    seamParseConstraints(): N.Node[] {
      const out: N.Node[] = [];
      for (;;) {
        const word = this.match(tt._in) && !this.state.containsEsc ? "in" : CONSTRAINT_WORDS.find(w => this.seamAtWord(w));
        if (word === undefined) break;
        if (this.hasPrecedingLineBreak()) {
          const next = this.input[this.nextTokenStart()];
          if (next === undefined || MEMBER_FOLLOWERS.has(next)) break;
        }
        const node = this.startNode() as Undone<any>;
        node.kind = word;
        if (word === "in") {
          RANGE.lastIndex = this.state.end;
          const m = RANGE.exec(this.input);
          if (m === null) throw this.raise(Errors.UnexpectedToken, this.state.endLoc, { expected: "a range such as 1..100" });
          const to = RANGE.lastIndex;
          const endLoc = createPositionWithColumnOffset(this.state.endLoc, to - this.state.end);
          node.min = m![1]!.replace(/[ \t]/g, "");
          node.max = m![2]!.replace(/[ \t]/g, "");
          this.state.pos = to;
          this.next();
          this.state.lastTokEndLoc = endLoc;
          out.push(this.finishNodeAt(node, "SeamConstraint", endLoc));
          continue;
        }
        this.next(); // eat the word
        if (word === "matches") {
          if (!this.match(tt.slash) && !this.match(tt.slashAssign)) throw this.raise(Errors.UnexpectedToken, this.state.startLoc, { expected: "a regular expression literal" });
          this.readRegexp();
          node.pattern = this.parseRegExpLiteral(this.state.value);
        } else {
          if (!this.match(tt.num)) throw this.raise(Errors.UnexpectedToken, this.state.startLoc, { expected: "a number" });
          node.value = this.state.value;
          this.next();
        }
        out.push(this.finishNode(node, "SeamConstraint"));
      }
      return out;
    }

    // ======================================================
    // OVERRIDES
    // ======================================================

    tsTryParseTypeAnnotation(): N.TSTypeAnnotation | undefined {
      const own = this.seamFieldAnnotation;
      // Annotations nested in the field's type (a function type's parameters, an
      // inline object type) take no constraints.
      this.seamFieldAnnotation = false;
      let type: N.TSTypeAnnotation | undefined;
      try {
        type = super.tsTryParseTypeAnnotation();
      } finally {
        this.seamFieldAnnotation = own;
      }
      if (own && type) {
        const constraints = this.seamParseConstraints();
        if (constraints.length > 0) (type as any).constraints = constraints;
      }
      return type;
    }

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
