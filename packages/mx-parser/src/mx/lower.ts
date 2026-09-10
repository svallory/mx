import type { Expression, File } from "@babel/types";
import type { ParserOptions } from "../babel/index.ts";
import { parseExpression, parse as parseProgram } from "../babel/index.ts";
import type { AttrsContext } from "./attrs.ts";
import {
  lowerDynamicAttr,
  lowerShorthandClass,
  lowerShorthandId,
  lowerSpreadAttr,
  attrNameNode as sharedAttrNameNode,
} from "./attrs.ts";
import type {
  MxAttr,
  MxChild,
  MxElement,
  MxRange,
  MxWalkError,
} from "./walk.ts";

/**
 * A construct MX recognises but this task does not lower yet. Reported through
 * the caller's `raise` path so it reads as an ordinary parse error with a
 * position, never as a silently mis-lowered node.
 */
export interface LowerFailure {
  construct: string;
  start: number;
  end: number;
}

export class LowerError extends Error {
  constructor(readonly failure: LowerFailure) {
    super(failure.construct);
    this.name = "LowerError";
  }
}

export interface LowerContext {
  source: string;
  /** Parser options to reuse for every sub-parse of an expression range. */
  options: ParserOptions;
}

/** Any Babel node; the vendored parser's internal node types are structural. */
type Node = Record<string, unknown>;

function fail(construct: string, range: MxRange): never {
  throw new LowerError({
    construct,
    start: range.start,
    end: range.end,
  });
}

/** Line/column of an absolute offset, for the sub-parser's start options. */
function positionOf(source: string, offset: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return [line, offset - lineStart];
}

/**
 * Parses one expression range as TypeScript with the vendored parser, using
 * Babel's `startIndex`/`startLine`/`startColumn` so every node's `loc`/`start`/
 * `end` points into the original `.solid.mx` file rather than into the slice.
 *
 * Nested MX inside the range works for free: this is the same parser, so an
 * attr-method body containing `<span>x</span>` re-enters the MX bridge.
 *
 * A SyntaxError from the sub-parse is rethrown as-is. It already describes the
 * real problem at a real position inside the expression (`${a b}` is a missing
 * semicolon at the `b`, not "placeholder is not supported"), and its offsets are
 * absolute because of the `startIndex`/`startLine`/`startColumn` above. Only a
 * non-SyntaxError — which would mean the range itself was nonsense rather than
 * the code in it — becomes an "unsupported construct" report.
 */
function subParse(ctx: LowerContext, range: MxRange, what: string): Expression {
  const text = ctx.source.slice(range.start, range.end);
  const [line, column] = positionOf(ctx.source, range.start);
  try {
    return parseExpression(text, {
      ...ctx.options,
      startIndex: range.start,
      startLine: line,
      startColumn: column,
    }) as Expression;
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    return fail(what, range);
  }
}

function loc(source: string, range: MxRange) {
  const [sl, sc] = positionOf(source, range.start);
  const [el, ec] = positionOf(source, range.end);
  return {
    start: { line: sl, column: sc, index: range.start },
    end: { line: el, column: ec, index: range.end },
  };
}

/** Stamps position fields onto a synthesised node. */
function at<T extends Node>(node: T, source: string, range: MxRange): T {
  const positioned = node as Node;
  positioned.start = range.start;
  positioned.end = range.end;
  positioned.loc = loc(source, range);
  positioned.range = [range.start, range.end];
  return node;
}

function jsxIdentifier(ctx: LowerContext, name: string, range: MxRange): Node {
  return at({ type: "JSXIdentifier", name }, ctx.source, range);
}

/**
 * Marko whitespace rules for MX text, which are not JSX's.
 *
 * - A whitespace-only run containing a newline is dropped entirely. This is the
 *   rule that makes indented markup behave: `<p>\n  ${a}\n  ${b}\n</p>` has no
 *   text between the two expression containers, so nothing renders between
 *   them. JSX would keep a space here.
 * - A whitespace-only run with no newline collapses to a single space, so
 *   `${a} ${b}` on one line keeps the space the author typed.
 * - In a run with actual content, internal whitespace collapses to one space,
 *   and leading/trailing whitespace is trimmed where the run meets a tag
 *   boundary.
 *
 * Authors who need a space the newline rule would drop write `${" "}`.
 *
 * Returns null when nothing survives.
 */
export function normalizeText(
  raw: string,
  atStart: boolean,
  atEnd: boolean,
): string | null {
  if (raw.trim() === "") {
    // Whitespace-only run: a newline means layout indentation, not content.
    if (raw.includes("\n")) return null;
    return atStart || atEnd ? null : " ";
  }

  let text = raw.replace(/\s+/g, " ");
  if (atStart) text = text.replace(/^ /, "");
  if (atEnd) text = text.replace(/ $/, "");
  if (text === "") return null;
  return text;
}

/** Builds the `AttrsContext` view of `lower.ts`'s shared helpers, for `attrs.ts`. */
function attrsContext(ctx: LowerContext): AttrsContext {
  return {
    source: ctx.source,
    fail: (construct, range) => fail(construct, range),
    subParse: (range, what) => subParse(ctx, range, what) as unknown as Node,
    at: (node, range) => at(node, ctx.source, range),
    jsxIdentifier: (name, range) => jsxIdentifier(ctx, name, range),
  };
}

/** `lower.ts`'s attribute-name lowering, shared with `attrs.ts` via `sharedAttrNameNode` so the namespaced-name split and its validation live in one place. */
function attrNameNode(
  ctx: LowerContext,
  name: string,
  nameRange: MxRange,
): Node {
  return sharedAttrNameNode(attrsContext(ctx), name, nameRange);
}

function lowerAttr(
  ctx: LowerContext,
  attr: MxAttr,
  hasShorthandClass: boolean,
): Node {
  switch (attr.kind) {
    case "static": {
      // The recorded range keeps the original quotes, which is exactly what a
      // StringLiteral's raw form needs.
      const raw = ctx.source.slice(attr.value.start, attr.value.end);
      const value = raw.slice(1, -1);
      const literal = at(
        {
          type: "StringLiteral",
          value,
          extra: { raw, rawValue: value },
        },
        ctx.source,
        attr.value,
      );
      return at(
        {
          type: "JSXAttribute",
          name: attrNameNode(ctx, attr.name, attr.nameRange),
          value: literal,
        },
        ctx.source,
        { start: attr.nameRange.start, end: attr.value.end },
      );
    }

    case "dynamic":
      return lowerDynamicAttr(attrsContext(ctx), attr, hasShorthandClass);

    case "boolean": {
      const literal = at(
        { type: "BooleanLiteral", value: true },
        ctx.source,
        attr.nameRange,
      );
      const container = at(
        { type: "JSXExpressionContainer", expression: literal },
        ctx.source,
        attr.nameRange,
      );
      return at(
        {
          type: "JSXAttribute",
          name: attrNameNode(ctx, attr.name, attr.nameRange),
          value: container,
        },
        ctx.source,
        attr.nameRange,
      );
    }

    case "method": {
      // `onClick(p) { body }` becomes `onClick={(p) => { body }}`. The body
      // stays a BlockStatement: it is never unwrapped to an expression body,
      // even when it holds a single expression statement, so what the author
      // wrote is what the AST says.
      //
      // Params and body are parsed separately rather than as one synthesised
      // `(p) => { body }` string, because MX writes no `=>` — synthesising one
      // shifts every node after it, and the gap between `)` and `{` is often
      // too small to pad. Parsed apart, each half keeps its true offsets and
      // the arrow node is assembled around them.
      const arrowRange: MxRange = {
        start: attr.params.start,
        end: attr.body.end,
      };

      const paramsText = ctx.source.slice(attr.params.start, attr.params.end);
      const [pLine, pColumn] = positionOf(ctx.source, attr.params.start - 1);
      let params: unknown[];
      try {
        const probe = parseExpression(`(${paramsText})=>0`, {
          ...ctx.options,
          startIndex: attr.params.start - 1,
          startLine: pLine,
          startColumn: pColumn,
        }) as unknown as { params: unknown[] };
        params = probe.params;
      } catch (err) {
        if (err instanceof SyntaxError) throw err;
        return fail("attribute method parameters", attr.params);
      }

      // htmljs-parser's body range covers the statements *between* the braces,
      // not the braces themselves, so the block is reconstructed by putting a
      // `{` back exactly where the source had it (one char before the range)
      // and a `}` where it closed. Both sit at their true offsets, so every
      // statement inside keeps its real position.
      const bodyOpen = attr.body.start - 1;
      const bodyText = `{${ctx.source.slice(attr.body.start, attr.body.end)}}`;
      const [bLine, bColumn] = positionOf(ctx.source, bodyOpen);
      let body: Node;
      try {
        const program = parseProgram(bodyText, {
          ...ctx.options,
          startIndex: bodyOpen,
          startLine: bLine,
          startColumn: bColumn,
        });
        const first = program.program.body[0] as unknown as Node | undefined;
        if (first?.type !== "BlockStatement") {
          return fail("attribute method body", attr.body);
        }
        body = first;
      } catch (err) {
        if (err instanceof SyntaxError) throw err;
        return fail("attribute method body", attr.body);
      }

      const arrow = at(
        {
          type: "ArrowFunctionExpression",
          id: null,
          generator: false,
          async: attr.async,
          params,
          body,
        },
        ctx.source,
        arrowRange,
      );
      const container = at(
        { type: "JSXExpressionContainer", expression: arrow },
        ctx.source,
        arrowRange,
      );
      return at(
        {
          type: "JSXAttribute",
          name: attrNameNode(ctx, attr.name, attr.nameRange),
          value: container,
        },
        ctx.source,
        { start: attr.nameRange.start, end: attr.body.end },
      );
    }

    case "spread":
      return lowerSpreadAttr(attrsContext(ctx), attr);

    case "bound":
      return fail("bound attribute (`:=`)", attr.value);
  }
}

/**
 * Returns the `$!{...}` (raw, unescaped) placeholder child when it is the
 * element's only content-bearing child (comments and pure-whitespace text
 * runs do not count), else null. Whitespace and comments are allowed
 * alongside it because they contribute nothing to the rendered output either
 * way; any other child makes it "mixed", which `lowerChildren` rejects.
 */
function soleRawPlaceholder(
  ctx: LowerContext,
  children: MxChild[],
): Extract<MxChild, { kind: "placeholder" }> | null {
  let found: Extract<MxChild, { kind: "placeholder" }> | null = null;
  for (const child of children) {
    if (child.kind === "comment") continue;
    if (child.kind === "text") {
      const raw = ctx.source.slice(child.range.start, child.range.end);
      if (raw.trim() === "") continue;
      return null;
    }
    if (child.kind === "placeholder" && !child.escape) {
      if (found) return null;
      found = child;
      continue;
    }
    return null;
  }
  return found;
}

function lowerChildren(ctx: LowerContext, children: MxChild[]): Node[] {
  const out: Node[] = [];
  // Comments are dropped from the output, so they do not count as content when
  // deciding whether a text run touches a tag boundary: the whitespace around
  // `<!-- x -->` trims exactly as it would if the comment were not written.
  const isContent = (child: MxChild) => child.kind !== "comment";
  const firstContent = children.findIndex(isContent);
  let lastContent = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child && isContent(child)) {
      lastContent = i;
      break;
    }
  }

  children.forEach((child, index) => {
    switch (child.kind) {
      case "text": {
        const raw = ctx.source.slice(child.range.start, child.range.end);
        const text = normalizeText(
          raw,
          index === firstContent,
          index === lastContent,
        );
        if (text === null) return;
        out.push(
          at(
            {
              type: "JSXText",
              value: text,
              extra: { raw: text, rawValue: text },
            },
            ctx.source,
            child.range,
          ),
        );
        return;
      }

      case "placeholder": {
        if (!child.escape) {
          // The sole-child case (`innerHTML`) is handled in `lowerElement`
          // before children are lowered; reaching here means `$!{}` was mixed
          // with other children.
          fail("raw placeholder must be the only child", child.range);
        }
        const expression = subParse(ctx, child.value, "placeholder");
        out.push(
          at(
            { type: "JSXExpressionContainer", expression },
            ctx.source,
            child.range,
          ),
        );
        return;
      }

      case "element":
        out.push(lowerElement(ctx, child.element));
        return;

      case "comment":
        return;
    }
  });
  return out;
}

/** Tags whose lowering this task does not cover. */
const UNSUPPORTED_TAGS: Record<string, string> = {
  if: "`<if>`",
  else: "`<else>`",
  for: "`<for>`",
  try: "`<try>`",
  fragment: "`<fragment>`",
};

export function lowerElement(ctx: LowerContext, el: MxElement): Node {
  if (el.staticName === null) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: naming MX syntax in an error message
    fail("dynamic tag name (`<${...}>`)", el.name);
  }
  const name = el.staticName;

  if (name.startsWith("@")) {
    fail(`attribute tag (\`<${name}>\`)`, el.name);
  }
  const unsupported = UNSUPPORTED_TAGS[name];
  if (unsupported) fail(unsupported, el.name);

  if (el.params) fail("tag params (`|a, b|`)", el.params);
  if (el.tagArgs) fail("tag arguments", el.tagArgs);
  if (el.tagVar) fail("tag variable (`/name`)", el.tagVar);
  if (name.includes(":")) fail(`namespaced tag \`<${name}>\``, el.name);

  const hasShorthandClass = el.shorthandClasses.length > 0;
  const hasShorthandId = el.shorthandIds.length > 0;

  const explicitStaticClass = el.attrs.find(
    (a): a is Extract<MxAttr, { kind: "static" }> =>
      a.kind === "static" && a.name === "class",
  );
  // A non-object `class={...}` combined with shorthand classes is rejected
  // inside `attrs.ts` (`lowerDynamicAttr` receives `hasShorthandClass`); the
  // object-literal case there is rejected the same way, so no check is
  // needed here beyond passing the flag through.
  const hasExplicitId = el.attrs.some(
    (a) => a.kind !== "spread" && a.kind !== "bound" && a.name === "id",
  );
  if (hasShorthandId && hasExplicitId) {
    fail(
      "`#id` shorthand combined with an explicit `id=` attribute",
      el.shorthandIds[0] as MxRange,
    );
  }

  // The shorthand-merge case (`class`) is emitted at the *explicit* class
  // attribute's position in the loop below, not hoisted to the front: a
  // preceding spread must still be able to override the shorthand class (and
  // a following one still override it back), so the merged attribute has to
  // land wherever the author wrote `class=`. Only when there is no explicit
  // class to merge with does the shorthand have no position of its own to
  // take — it is synthesised from the tag name, not an attribute in the
  // list — so it is pushed to the front in that case only.
  const attributes: Node[] = [];
  if (hasShorthandClass && !explicitStaticClass) {
    attributes.push(lowerShorthandClass(attrsContext(ctx), el, null));
  }
  if (hasShorthandId) {
    attributes.push(
      lowerShorthandId(attrsContext(ctx), el.shorthandIds[0] as MxRange),
    );
  }
  for (const attr of el.attrs) {
    if (hasShorthandClass && attr.kind === "static" && attr.name === "class") {
      attributes.push(lowerShorthandClass(attrsContext(ctx), el, attr));
      continue;
    }
    attributes.push(lowerAttr(ctx, attr, hasShorthandClass));
  }

  // `$!{html}` as the sole child becomes an `innerHTML` attribute instead of a
  // child; mixed with any other child (even whitespace-only text) it is a
  // parse error, raised inside `lowerChildren` when it is not the sole
  // content-bearing child.
  const rawChild = soleRawPlaceholder(ctx, el.children);
  let children: Node[];
  if (rawChild) {
    const hasExplicitInnerHtml = el.attrs.some(
      (a) =>
        a.kind !== "spread" && a.kind !== "bound" && a.name === "innerHTML",
    );
    if (hasExplicitInnerHtml) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        rawChild.range,
      );
    }
    const expression = subParse(ctx, rawChild.value, "raw placeholder");
    attributes.push(
      at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, "innerHTML", rawChild.range),
          value: at(
            { type: "JSXExpressionContainer", expression },
            ctx.source,
            rawChild.value,
          ),
        },
        ctx.source,
        rawChild.range,
      ),
    );
    children = [];
  } else {
    children = lowerChildren(ctx, el.children);
  }

  // The opening element spans `<name ...>`; when the tag self-closes that is
  // the whole element.
  const openingEnd = el.selfClosing
    ? el.range.end
    : children.length > 0
      ? (children[0] as { start: number }).start
      : el.range.end;

  const opening = at(
    {
      type: "JSXOpeningElement",
      name: jsxIdentifier(ctx, name, el.name),
      attributes,
      selfClosing: el.selfClosing,
      typeArguments: null,
    },
    ctx.source,
    { start: el.range.start, end: openingEnd },
  );

  // The closing element spans the real `</name>` when there was one, so source
  // maps point at the closing tag rather than collapsing to a zero-width span.
  const closeRange = el.closeRange;
  const closing =
    el.selfClosing || closeRange === null
      ? null
      : at(
          {
            type: "JSXClosingElement",
            name: jsxIdentifier(ctx, name, {
              start: closeRange.start + 2,
              end: closeRange.end - 1,
            }),
          },
          ctx.source,
          closeRange,
        );

  return at(
    {
      type: "JSXElement",
      openingElement: opening,
      closingElement: closing,
      children,
      extra: { mx: { range: [el.range.start, el.range.end] } },
    },
    ctx.source,
    el.range,
  );
}

export type { File, MxWalkError };
