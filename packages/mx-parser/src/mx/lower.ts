import type { Expression, File } from "@babel/types";
import type { ParserOptions } from "../babel/index.ts";
import { parseExpression, parse as parseProgram } from "../babel/index.ts";
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
  } catch {
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
 * Marko whitespace rules for MX text, as far as this task needs them: a run of
 * whitespace that touches a tag boundary is dropped, and every internal run
 * collapses to a single space. Returns null when nothing survives.
 */
export function normalizeText(
  raw: string,
  atStart: boolean,
  atEnd: boolean,
): string | null {
  let text = raw.replace(/\s+/g, " ");
  if (atStart) text = text.replace(/^ /, "");
  if (atEnd) text = text.replace(/ $/, "");
  if (text === "") return null;
  return text;
}

function lowerAttr(ctx: LowerContext, attr: MxAttr): Node {
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
          name: jsxIdentifier(ctx, attr.name, attr.nameRange),
          value: literal,
        },
        ctx.source,
        { start: attr.nameRange.start, end: attr.value.end },
      );
    }

    case "dynamic": {
      const expression = subParse(ctx, attr.value, "attribute value");
      const container = at(
        { type: "JSXExpressionContainer", expression },
        ctx.source,
        attr.value,
      );
      return at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, attr.name, attr.nameRange),
          value: container,
        },
        ctx.source,
        { start: attr.nameRange.start, end: attr.value.end },
      );
    }

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
          name: jsxIdentifier(ctx, attr.name, attr.nameRange),
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
      } catch {
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
      } catch {
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
          name: jsxIdentifier(ctx, attr.name, attr.nameRange),
          value: container,
        },
        ctx.source,
        { start: attr.nameRange.start, end: attr.body.end },
      );
    }

    case "spread":
      return fail("spread attribute (`...props`)", attr.range);

    case "bound":
      return fail("bound attribute (`:=`)", attr.value);
  }
}

function lowerChildren(ctx: LowerContext, children: MxChild[]): Node[] {
  const out: Node[] = [];
  children.forEach((child, index) => {
    switch (child.kind) {
      case "text": {
        const raw = ctx.source.slice(child.range.start, child.range.end);
        const text = normalizeText(
          raw,
          index === 0,
          index === children.length - 1,
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
          fail("`$!{...}` (unescaped placeholder)", child.range);
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

  if (el.shorthandClasses.length > 0) {
    fail("`.class` shorthand", el.shorthandClasses[0] as MxRange);
  }
  if (el.shorthandIds.length > 0) {
    fail("`#id` shorthand", el.shorthandIds[0] as MxRange);
  }
  if (el.params) fail("tag params (`|a, b|`)", el.params);
  if (el.tagArgs) fail("tag arguments", el.tagArgs);
  if (el.tagVar) fail("tag variable (`/name`)", el.tagVar);
  if (name.includes(":")) fail(`namespaced tag \`<${name}>\``, el.name);

  for (const attr of el.attrs) {
    if (attr.kind !== "spread" && attr.name.includes(":")) {
      fail(`namespaced attribute \`${attr.name}\``, attr.nameRange);
    }
  }

  const attributes = el.attrs.map((attr) => lowerAttr(ctx, attr));
  const children = lowerChildren(ctx, el.children);

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

  const closing = el.selfClosing
    ? null
    : at(
        {
          type: "JSXClosingElement",
          name: jsxIdentifier(ctx, name, el.name),
        },
        ctx.source,
        { start: el.range.end, end: el.range.end },
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
