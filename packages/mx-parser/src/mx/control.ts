import { parseExpression } from "../babel/index.ts";
import {
  at,
  fail,
  jsxIdentifier,
  type LowerContext,
  lowerChildren as lowerChildrenNodes,
  type Node,
  positionOf,
  subParse,
} from "./lower.ts";
import type { MxAttr, MxChild, MxElement, MxRange } from "./walk.ts";

/** Tags this module handles; `lower.ts` dispatches to it by these names. */
export const CONTROL_TAGS = new Set(["if", "else", "for", "fragment"]);

function attrByName(el: MxElement, name: string): MxAttr | undefined {
  return el.attrs.find((a) => "name" in a && a.name === name);
}

/** The `=cond` shorthand value attribute htmljs-parser reports with an empty name. */
function shorthandValueAttr(el: MxElement): MxAttr | undefined {
  return attrByName(el, "");
}

function jsxFragment(
  ctx: LowerContext,
  children: Node[],
  range: MxRange,
): Node {
  return at(
    {
      type: "JSXFragment",
      openingFragment: at({ type: "JSXOpeningFragment" }, ctx.source, range),
      closingFragment: at({ type: "JSXClosingFragment" }, ctx.source, range),
      children,
    },
    ctx.source,
    range,
  );
}

/**
 * Turns a lowered child list into a single node valid in *expression*
 * position — a `Show`/`Match` `fallback={...}`, or the body of the
 * `|params|` callback arrow, both of which every caller here needs (even the
 * no-params case pushes this node bare into a `children:` array, where an
 * expression-safe node is equally valid).
 *
 * - A single `JSXElement`/`JSXFragment` is already a valid expression: return
 *   it bare, e.g. `<Login />`.
 * - A single `JSXExpressionContainer` (a lone `${...}` or one child element
 *   that itself lowered to one) is unwrapped to its `.expression`: the
 *   container syntax only exists inside JSX children, not in expression
 *   position, so `fallback={{expr}}` (a container inside a container) would
 *   either throw or, for a lone `JSXText`, silently turn the text into an
 *   identifier reference.
 * - Anything else (zero children, a lone `JSXText`, or more than one child)
 *   wraps in a `JSXFragment`, which is itself a valid expression.
 */
function wrapChildren(
  ctx: LowerContext,
  children: Node[],
  range: MxRange,
): Node {
  const first = children[0];
  if (children.length === 1 && first) {
    if (first.type === "JSXElement" || first.type === "JSXFragment") {
      return first;
    }
    if (first.type === "JSXExpressionContainer") {
      return first.expression as Node;
    }
  }
  return jsxFragment(ctx, children, range);
}

function elementChildrenRange(el: MxElement): MxRange {
  if (el.children.length === 0) return el.range;
  const first = el.children[0] as MxChild;
  const last = el.children[el.children.length - 1] as MxChild;
  const start = childRange(first).start;
  const end = childRange(last).end;
  return { start, end };
}

function childRange(child: MxChild): MxRange {
  switch (child.kind) {
    case "text":
    case "placeholder":
    case "comment":
      return child.range;
    case "element":
      return child.element.range;
  }
}

function lowerBody(ctx: LowerContext, el: MxElement): Node {
  const children = lowerChildrenNodes(ctx, el.children);
  return wrapChildren(ctx, children, elementChildrenRange(el));
}

/**
 * Wraps a body in a callback child: `{(param) => body}` for `<Show>`'s
 * narrowing form and `<for>`'s per-item render.
 */
function callbackChild(
  ctx: LowerContext,
  params: unknown[],
  body: Node,
  range: MxRange,
): Node {
  const arrow = at(
    {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: false,
      params,
      body,
    },
    ctx.source,
    range,
  );
  return at(
    { type: "JSXExpressionContainer", expression: arrow },
    ctx.source,
    range,
  );
}

/** `subParse` returns a Babel `Expression`; every caller here treats it as a `Node`. */
function subParseNode(ctx: LowerContext, range: MxRange, what: string): Node {
  return subParse(ctx, range, what) as unknown as Node;
}

/**
 * Tag params (`|a, b|`) are parsed the same way attribute method params are:
 * as the parameter list of a synthesised arrow, one character before the `|`
 * so offsets land on the real source.
 */
function tagParams(ctx: LowerContext, params: MxRange): unknown[] {
  const paramsText = ctx.source.slice(params.start, params.end);
  const [line, column] = positionOf(ctx.source, params.start - 1);
  try {
    const probe = parseExpression(`(${paramsText})=>0`, {
      ...ctx.options,
      startIndex: params.start - 1,
      startLine: line,
      startColumn: column,
    }) as unknown as { params: unknown[] };
    return probe.params;
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    return fail("tag params (`|a, b|`)", params);
  }
}

function showElement(
  ctx: LowerContext,
  when: Node,
  body: Node,
  fallback: Node | null,
  params: unknown[] | null,
  range: MxRange,
): Node {
  const attributes: Node[] = [
    at(
      {
        type: "JSXAttribute",
        name: jsxIdentifier(ctx, "when", range),
        value: at(
          { type: "JSXExpressionContainer", expression: when },
          ctx.source,
          range,
        ),
      },
      ctx.source,
      range,
    ),
  ];
  if (fallback) {
    attributes.push(
      at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, "fallback", range),
          value: at(
            { type: "JSXExpressionContainer", expression: fallback },
            ctx.source,
            range,
          ),
        },
        ctx.source,
        range,
      ),
    );
  }

  const children = params ? [callbackChild(ctx, params, body, range)] : [body];

  return at(
    {
      type: "JSXElement",
      openingElement: at(
        {
          type: "JSXOpeningElement",
          name: jsxIdentifier(ctx, "Show", range),
          attributes,
          selfClosing: false,
          typeArguments: null,
        },
        ctx.source,
        range,
      ),
      closingElement: at(
        { type: "JSXClosingElement", name: jsxIdentifier(ctx, "Show", range) },
        ctx.source,
        range,
      ),
      children,
      extra: {},
    },
    ctx.source,
    range,
  );
}

interface IfBranch {
  when: Node;
  body: Node;
  params: unknown[] | null;
  range: MxRange;
}

function lowerIfHeader(
  ctx: LowerContext,
  el: MxElement,
  isElseIf: boolean,
): IfBranch {
  const condAttr = isElseIf ? attrByName(el, "if") : shorthandValueAttr(el);
  if (el.tagArgs) {
    fail(
      isElseIf
        ? "`<else if(cond)>` (use `<else if=cond>`)"
        : "`<if(cond)>` (use `<if=cond>`)",
      el.tagArgs,
    );
  }
  if (
    !condAttr ||
    condAttr.kind === "boolean" ||
    condAttr.kind === "spread" ||
    condAttr.kind === "method" ||
    condAttr.kind === "bound"
  ) {
    fail(
      isElseIf
        ? "`<else if>` without a condition"
        : "`<if>` without a condition",
      el.name,
    );
  }
  if (isElseIf && el.params) {
    fail("tag params (`|a, b|`) on `<else if>`", el.params);
  }
  const when = subParseNode(ctx, condAttr.value, "if condition");
  const params = el.params ? tagParams(ctx, el.params) : null;
  const body = lowerBody(ctx, el);
  return { when, body, params, range: el.range };
}

function isElseElement(
  child: MxChild,
): child is { kind: "element"; element: MxElement } {
  return child.kind === "element" && child.element.staticName === "else";
}

/** True for a Marko-whitespace-only text/comment run between `if`/`else` siblings. */
function isSkippable(child: MxChild, source: string): boolean {
  if (child.kind === "comment") return true;
  if (child.kind !== "text") return false;
  return source.slice(child.range.start, child.range.end).trim() === "";
}

/**
 * Lowers a lone `<if>` with no sibling chain to consume `<else>` from — e.g.
 * one reached directly through `lowerElement` rather than as a child in a
 * list, such as `<if=cond>x</if>` used as a bare expression.
 */
export function lowerStandaloneIf(ctx: LowerContext, el: MxElement): Node {
  const head = lowerIfHeader(ctx, el, false);
  return showElement(ctx, head.when, head.body, null, head.params, head.range);
}

/**
 * Consumes an `<if>` element and any immediately-following `<else if>`/`<else>`
 * siblings (skipping whitespace-only text and comments between them), and
 * returns the lowered `<Show>`/`<Switch>` node plus the index of the next
 * unconsumed sibling.
 */
export function lowerIfChain(
  ctx: LowerContext,
  children: MxChild[],
  index: number,
): { node: Node; nextIndex: number } {
  const ifChild = children[index] as { kind: "element"; element: MxElement };
  const head = lowerIfHeader(ctx, ifChild.element, false);

  const elseIfBranches: IfBranch[] = [];
  let elseBody: Node | null = null;
  let elseRange: MxRange | null = null;
  let i = index + 1;

  while (i < children.length) {
    const child = children[i] as MxChild;
    if (isSkippable(child, ctx.source)) {
      i++;
      continue;
    }
    if (!isElseElement(child)) break;
    const el = child.element;
    const isElseIf = attrByName(el, "if") !== undefined;
    if (isElseIf) {
      if (elseBody !== null) {
        fail("`<else if>` after `<else>`", el.name);
      }
      elseIfBranches.push(lowerIfHeader(ctx, el, true));
    } else {
      if (el.params) fail("tag params (`|a, b|`) on `<else>`", el.params);
      if (elseBody !== null) fail("duplicate `<else>`", el.name);
      elseBody = lowerBody(ctx, el);
      elseRange = el.range;
    }
    i++;
  }

  const lastRange =
    elseRange ?? elseIfBranches[elseIfBranches.length - 1]?.range ?? head.range;
  const fullRange: MxRange = { start: head.range.start, end: lastRange.end };

  let node: Node;
  if (elseIfBranches.length === 0) {
    node = showElement(
      ctx,
      head.when,
      head.body,
      elseBody,
      head.params,
      fullRange,
    );
  } else if (elseIfBranches.length === 1) {
    const branch = elseIfBranches[0] as IfBranch;
    // The nested Show covers only the `<else if>` onward, not the outer
    // `<if>` this Show is nested inside — using `fullRange` here would make
    // the two Shows' ranges overlap.
    const nestedRange: MxRange = {
      start: branch.range.start,
      end: fullRange.end,
    };
    const nested = showElement(
      ctx,
      branch.when,
      branch.body,
      elseBody,
      branch.params,
      nestedRange,
    );
    node = showElement(
      ctx,
      head.when,
      head.body,
      nested,
      head.params,
      fullRange,
    );
  } else {
    node = switchElement(ctx, [head, ...elseIfBranches], elseBody, fullRange);
  }

  return { node, nextIndex: i };
}

function switchElement(
  ctx: LowerContext,
  branches: IfBranch[],
  fallback: Node | null,
  range: MxRange,
): Node {
  const attributes: Node[] = [];
  if (fallback) {
    attributes.push(
      at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, "fallback", range),
          value: at(
            { type: "JSXExpressionContainer", expression: fallback },
            ctx.source,
            range,
          ),
        },
        ctx.source,
        range,
      ),
    );
  }

  const matches = branches.map((branch) => {
    const matchAttrs = [
      at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, "when", branch.range),
          value: at(
            { type: "JSXExpressionContainer", expression: branch.when },
            ctx.source,
            branch.range,
          ),
        },
        ctx.source,
        branch.range,
      ),
    ];
    const matchChildren = branch.params
      ? [callbackChild(ctx, branch.params, branch.body, branch.range)]
      : [branch.body];
    return at(
      {
        type: "JSXElement",
        openingElement: at(
          {
            type: "JSXOpeningElement",
            name: jsxIdentifier(ctx, "Match", branch.range),
            attributes: matchAttrs,
            selfClosing: false,
            typeArguments: null,
          },
          ctx.source,
          branch.range,
        ),
        closingElement: at(
          {
            type: "JSXClosingElement",
            name: jsxIdentifier(ctx, "Match", branch.range),
          },
          ctx.source,
          branch.range,
        ),
        children: matchChildren,
        extra: {},
      },
      ctx.source,
      branch.range,
    );
  });

  return at(
    {
      type: "JSXElement",
      openingElement: at(
        {
          type: "JSXOpeningElement",
          name: jsxIdentifier(ctx, "Switch", range),
          attributes,
          selfClosing: false,
          typeArguments: null,
        },
        ctx.source,
        range,
      ),
      closingElement: at(
        {
          type: "JSXClosingElement",
          name: jsxIdentifier(ctx, "Switch", range),
        },
        ctx.source,
        range,
      ),
      children: matches,
      extra: {},
    },
    ctx.source,
    range,
  );
}

function markNeedsImport(node: Node, names: string[]): void {
  const extra = (node.extra as Record<string, unknown> | undefined) ?? {};
  const mx = (extra.mx as Record<string, unknown> | undefined) ?? {};
  mx.needsImport = names;
  extra.mx = mx;
  node.extra = extra;
}

function listElement(
  ctx: LowerContext,
  componentName: "Index" | "For" | "Key",
  each: Node,
  by: Node | null,
  params: unknown[],
  body: Node,
  range: MxRange,
): Node {
  const attributes: Node[] = [
    at(
      {
        type: "JSXAttribute",
        name: jsxIdentifier(ctx, "each", range),
        value: at(
          { type: "JSXExpressionContainer", expression: each },
          ctx.source,
          range,
        ),
      },
      ctx.source,
      range,
    ),
  ];
  if (by) {
    attributes.push(
      at(
        {
          type: "JSXAttribute",
          name: jsxIdentifier(ctx, "by", range),
          value: at(
            { type: "JSXExpressionContainer", expression: by },
            ctx.source,
            range,
          ),
        },
        ctx.source,
        range,
      ),
    );
  }

  const node = at(
    {
      type: "JSXElement",
      openingElement: at(
        {
          type: "JSXOpeningElement",
          name: jsxIdentifier(ctx, componentName, range),
          attributes,
          selfClosing: false,
          typeArguments: null,
        },
        ctx.source,
        range,
      ),
      closingElement: at(
        {
          type: "JSXClosingElement",
          name: jsxIdentifier(ctx, componentName, range),
        },
        ctx.source,
        range,
      ),
      children: [callbackChild(ctx, params, body, range)],
      extra: {},
    },
    ctx.source,
    range,
  );
  return node;
}

/** `mxRange(from, to, step, inclusive)` call, for `<for from= to= until= step=>`. */
function mxRangeCall(
  ctx: LowerContext,
  from: Node,
  to: Node,
  step: Node,
  inclusive: boolean,
  range: MxRange,
): Node {
  const inclusiveLiteral = at(
    { type: "BooleanLiteral", value: inclusive },
    ctx.source,
    range,
  );
  return at(
    {
      type: "CallExpression",
      callee: jsxIdentifier(ctx, "mxRange", range) as unknown as Node,
      arguments: [from, to, step, inclusiveLiteral],
      optional: false,
    },
    ctx.source,
    range,
  ) as unknown as Node;
}

export function lowerFor(ctx: LowerContext, el: MxElement): Node {
  if (!el.params) fail("`<for>` without tag params (`|a, b|`)", el.name);
  const of = attrByName(el, "of");
  const by = attrByName(el, "by");
  const inAttr = attrByName(el, "in");
  const from = attrByName(el, "from");
  const to = attrByName(el, "to");
  const until = attrByName(el, "until");
  const step = attrByName(el, "step");

  const combos = [of, inAttr, from || to || until].filter(Boolean).length;
  if (combos > 1) {
    fail(
      "`<for>` with more than one of `of=`, `in=`, `from=`/`to=`/`until=`",
      el.name,
    );
  }

  const body = lowerBody(ctx, el);

  if (of) {
    if (of.kind !== "dynamic" && of.kind !== "static") {
      fail("`<for of=...>` requires an expression value", el.name);
    }
    const eachExpr = subParseNode(ctx, of.value, "for `of` expression");
    const params = tagParams(ctx, el.params);

    if (!by) {
      return listElement(ctx, "Index", eachExpr, null, params, body, el.range);
    }

    if (by.kind !== "dynamic" && by.kind !== "static") {
      fail("`<for by=...>` requires an expression value", el.name);
    }
    const byText = ctx.source.slice(by.value.start, by.value.end);
    if (by.kind === "dynamic" && byText.trim() === "identity") {
      return listElement(ctx, "For", eachExpr, null, params, body, el.range);
    }

    const byExpr =
      by.kind === "static"
        ? at(
            {
              type: "StringLiteral",
              value: byText.slice(1, -1),
              extra: { raw: byText, rawValue: byText.slice(1, -1) },
            },
            ctx.source,
            by.value,
          )
        : subParseNode(ctx, by.value, "for `by` expression");
    const node = listElement(
      ctx,
      "Key",
      eachExpr,
      byExpr,
      params,
      body,
      el.range,
    );
    markNeedsImport(node, ["Key"]);
    return node;
  }

  if (inAttr) {
    if (inAttr.kind !== "dynamic" && inAttr.kind !== "static") {
      fail("`<for in=...>` requires an expression value", el.name);
    }
    const objExpr = subParseNode(ctx, inAttr.value, "for `in` expression");
    const params = tagParams(ctx, el.params);

    const objectEntries = at(
      {
        type: "CallExpression",
        callee: at(
          {
            type: "MemberExpression",
            object: at(
              { type: "Identifier", name: "Object" },
              ctx.source,
              el.range,
            ),
            property: at(
              { type: "Identifier", name: "entries" },
              ctx.source,
              el.range,
            ),
            computed: false,
            optional: false,
          },
          ctx.source,
          el.range,
        ),
        arguments: [objExpr],
        optional: false,
      },
      ctx.source,
      el.range,
    );

    const eParam = at({ type: "Identifier", name: "e" }, ctx.source, el.range);
    const byArrow = at(
      {
        type: "ArrowFunctionExpression",
        id: null,
        generator: false,
        async: false,
        params: [eParam],
        body: at(
          {
            type: "MemberExpression",
            object: at({ type: "Identifier", name: "e" }, ctx.source, el.range),
            property: at(
              {
                type: "NumericLiteral",
                value: 0,
                extra: { raw: "0", rawValue: 0 },
              },
              ctx.source,
              el.range,
            ),
            computed: true,
            optional: false,
          },
          ctx.source,
          el.range,
        ),
      },
      ctx.source,
      el.range,
    );

    // `<for|k, v| in=obj()>` destructures each `[k, v]` entry as the single
    // callback param, matching the spec's `([k, v]) => body` shape.
    const arrayPattern = at(
      { type: "ArrayPattern", elements: params },
      ctx.source,
      el.params as MxRange,
    );

    const node = listElement(
      ctx,
      "Key",
      objectEntries,
      byArrow,
      [arrayPattern],
      body,
      el.range,
    );
    markNeedsImport(node, ["Key"]);
    return node;
  }

  if (from || to || until) {
    if (to && until) {
      fail("`<for>` with both `to=` and `until=`", el.name);
    }
    if (!to && !until) {
      fail("`<for>` requires `to=` or `until=`", el.name);
    }
    const params = tagParams(ctx, el.params);
    const zero = at(
      { type: "NumericLiteral", value: 0, extra: { raw: "0", rawValue: 0 } },
      ctx.source,
      el.range,
    );
    const one = at(
      { type: "NumericLiteral", value: 1, extra: { raw: "1", rawValue: 1 } },
      ctx.source,
      el.range,
    );
    const fromExpr =
      from && (from.kind === "dynamic" || from.kind === "static")
        ? subParseNode(ctx, from.value, "for `from` expression")
        : zero;
    const boundAttr = to ?? until;
    if (
      !boundAttr ||
      (boundAttr.kind !== "dynamic" && boundAttr.kind !== "static")
    ) {
      fail("`<for>` requires `to=` or `until=`", el.name);
    }
    const boundExpr = subParseNode(
      ctx,
      boundAttr.value,
      "for bound expression",
    );
    const stepExpr =
      step && (step.kind === "dynamic" || step.kind === "static")
        ? subParseNode(ctx, step.value, "for `step` expression")
        : one;
    const inclusive = to !== undefined;
    const eachExpr = mxRangeCall(
      ctx,
      fromExpr,
      boundExpr,
      stepExpr,
      inclusive,
      el.range,
    );
    const node = listElement(
      ctx,
      "Index",
      eachExpr,
      null,
      params,
      body,
      el.range,
    );
    markNeedsImport(node, ["mxRange"]);
    return node;
  }

  fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", el.name);
}

export function lowerFragment(ctx: LowerContext, el: MxElement): Node {
  const children = lowerChildrenNodes(ctx, el.children);
  return at(
    {
      type: "JSXFragment",
      openingFragment: at({ type: "JSXOpeningFragment" }, ctx.source, el.range),
      closingFragment: at({ type: "JSXClosingFragment" }, ctx.source, el.range),
      children,
    },
    ctx.source,
    el.range,
  );
}
