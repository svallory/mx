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
export const CONTROL_TAGS = new Set(["if", "else", "for", "fragment", "try"]);

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

/** A `name={expression}` JSX attribute. */
function exprAttribute(
  ctx: LowerContext,
  name: string,
  expression: Node,
  range: MxRange,
): Node {
  return at(
    {
      type: "JSXAttribute",
      name: jsxIdentifier(ctx, name, range),
      value: at(
        { type: "JSXExpressionContainer", expression },
        ctx.source,
        range,
      ),
    },
    ctx.source,
    range,
  );
}

/** A JSX element with the given name, attributes and children. */
function jsxElement(
  ctx: LowerContext,
  name: string,
  attributes: Node[],
  children: Node[],
  range: MxRange,
): Node {
  return at(
    {
      type: "JSXElement",
      openingElement: at(
        {
          type: "JSXOpeningElement",
          name: jsxIdentifier(ctx, name, range),
          attributes,
          selfClosing: false,
          typeArguments: null,
        },
        ctx.source,
        range,
      ),
      closingElement: at(
        { type: "JSXClosingElement", name: jsxIdentifier(ctx, name, range) },
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

function numericLiteral(
  ctx: LowerContext,
  value: number,
  range: MxRange,
): Node {
  return at(
    {
      type: "NumericLiteral",
      value,
      extra: { raw: String(value), rawValue: value },
    },
    ctx.source,
    range,
  );
}

function showElement(
  ctx: LowerContext,
  when: Node,
  body: Node,
  fallback: Node | null,
  params: unknown[] | null,
  range: MxRange,
): Node {
  const attributes: Node[] = [exprAttribute(ctx, "when", when, range)];
  if (fallback) {
    attributes.push(exprAttribute(ctx, "fallback", fallback, range));
  }

  const children = params ? [callbackChild(ctx, params, body, range)] : [body];

  return jsxElement(ctx, "Show", attributes, children, range);
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
    attributes.push(exprAttribute(ctx, "fallback", fallback, range));
  }

  const matches = branches.map((branch) => {
    const matchAttrs = [exprAttribute(ctx, "when", branch.when, branch.range)];
    const matchChildren = branch.params
      ? [callbackChild(ctx, branch.params, branch.body, branch.range)]
      : [branch.body];
    return jsxElement(ctx, "Match", matchAttrs, matchChildren, branch.range);
  });

  return jsxElement(ctx, "Switch", attributes, matches, range);
}

/**
 * `<For each={...}>` with an optional `keyed` prop, and `<Repeat>`.
 *
 * Solid 2 unified 1.x's `Index`/`For`/`Key` into a single `For` selected by
 * `keyed`, so every list row lands on the same component: `keyed={false}`
 * replaces `<Index>` (item accessor, index number), the default identity mode
 * replaces plain `<For>`, and `keyed={fn}` replaces the vendored `<Key>`
 * (both accessors). Nothing needs importing — both Solid 2 compilers
 * auto-import the builtIns list, which is why `needsImport` is gone.
 */
function listElement(
  ctx: LowerContext,
  each: Node,
  keyed: Node | null,
  params: unknown[],
  body: Node,
  range: MxRange,
): Node {
  const attributes: Node[] = [exprAttribute(ctx, "each", each, range)];
  if (keyed) {
    attributes.push(exprAttribute(ctx, "keyed", keyed, range));
  }
  return jsxElement(
    ctx,
    "For",
    attributes,
    [callbackChild(ctx, params, body, range)],
    range,
  );
}

/**
 * `<Repeat count={...} from={...}>` for `<for from= to=>` / `<for until=>`.
 *
 * `from` is emitted only when the author wrote it: `Repeat`'s own `from`
 * defaults to 0, so passing an explicit `from={0}` would be noise that no
 * hand-written twin would contain.
 */
function repeatElement(
  ctx: LowerContext,
  count: Node,
  from: Node | null,
  params: unknown[],
  body: Node,
  range: MxRange,
): Node {
  const attributes: Node[] = [exprAttribute(ctx, "count", count, range)];
  if (from) {
    attributes.push(exprAttribute(ctx, "from", from, range));
  }
  return jsxElement(
    ctx,
    "Repeat",
    attributes,
    [callbackChild(ctx, params, body, range)],
    range,
  );
}

/** Numeric value of a node that is literally a number, else null. */
function numericValueOf(node: Node): number | null {
  if (node.type === "NumericLiteral" && typeof node.value === "number") {
    return node.value;
  }
  return null;
}

/**
 * The iteration count for a range `<for>`: `to - from + 1` (inclusive) or
 * `until - from` (exclusive), as a `BinaryExpression` over the author's own
 * expressions.
 *
 * Folded to a single literal only when both bounds are numeric literals, so
 * `from=0 to=5` emits `count={6}` while `to=n()` emits the arithmetic. Any
 * non-literal bound has to stay an expression: its value is not known until
 * runtime, and `Repeat`'s `count` is a plain number it reads each time.
 */
function countExpression(
  ctx: LowerContext,
  from: Node,
  bound: Node,
  inclusive: boolean,
  range: MxRange,
): Node {
  const fromValue = numericValueOf(from);
  const boundValue = numericValueOf(bound);
  if (fromValue !== null && boundValue !== null) {
    const folded = inclusive
      ? boundValue - fromValue + 1
      : boundValue - fromValue;
    return numericLiteral(ctx, folded, range);
  }

  // `bound - from`, then `+ 1` for the inclusive form.
  const difference = at(
    {
      type: "BinaryExpression",
      operator: "-",
      left: bound,
      right: from,
    },
    ctx.source,
    range,
  );
  if (!inclusive) return difference;

  return at(
    {
      type: "BinaryExpression",
      operator: "+",
      left: difference,
      right: numericLiteral(ctx, 1, range),
    },
    ctx.source,
    range,
  );
}

/** `(x) => x.<field>`, the lowering of `by="field"`. */
function fieldKeyArrow(ctx: LowerContext, field: string, range: MxRange): Node {
  const param = at({ type: "Identifier", name: "x" }, ctx.source, range);
  const body = at(
    {
      type: "MemberExpression",
      object: at({ type: "Identifier", name: "x" }, ctx.source, range),
      property: at({ type: "Identifier", name: field }, ctx.source, range),
      computed: false,
      optional: false,
    },
    ctx.source,
    range,
  );
  return at(
    {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: false,
      params: [param],
      body,
    },
    ctx.source,
    range,
  );
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

  // `Repeat`'s index is a plain incrementing number with no stride concept, so
  // there is nothing to lower `step=` onto; a computed array is the workaround.
  if (step) {
    fail(
      "`<for step=...>`: step is not supported; use a computed array",
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

    // No `by=`: Marko keys by position, which is 2.0's `keyed={false}` —
    // item accessor, stable index number.
    if (!by) {
      const keyedFalse = at(
        { type: "BooleanLiteral", value: false },
        ctx.source,
        el.range,
      );
      return listElement(ctx, eachExpr, keyedFalse, params, body, el.range);
    }

    if (by.kind !== "dynamic" && by.kind !== "static") {
      fail("`<for by=...>` requires an expression value", el.name);
    }
    const byText = ctx.source.slice(by.value.start, by.value.end);

    // `by=identity` is identity keying, which is `For`'s default: emit no
    // `keyed` prop at all rather than an explicit `keyed={true}`.
    if (by.kind === "dynamic" && byText.trim() === "identity") {
      return listElement(ctx, eachExpr, null, params, body, el.range);
    }

    // `by="id"` names a field; `by=(fn)` is the key function itself.
    const keyedExpr =
      by.kind === "static"
        ? fieldKeyArrow(ctx, byText.slice(1, -1), by.value)
        : subParseNode(ctx, by.value, "for `by` expression");
    return listElement(ctx, eachExpr, keyedExpr, params, body, el.range);
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

    // Entries are keyed by their key, `e => e[0]`, so re-ordering an object's
    // keys moves rows instead of rebuilding them.
    const eParam = at({ type: "Identifier", name: "e" }, ctx.source, el.range);
    const keyedArrow = at(
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
            property: numericLiteral(ctx, 0, el.range),
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

    return listElement(
      ctx,
      objectEntries,
      keyedArrow,
      [arrayPattern],
      body,
      el.range,
    );
  }

  if (from || to || until) {
    if (to && until) {
      fail("`<for>` with both `to=` and `until=`", el.name);
    }
    if (!to && !until) {
      fail("`<for>` requires `to=` or `until=`", el.name);
    }
    const params = tagParams(ctx, el.params);
    // A written-but-valueless `from` (`<for|i| from to=5>`, or the spread /
    // method / bound kinds) is a mistake, not a request for the default: `to=`
    // and `until=` already reject exactly these kinds, and silently treating
    // `from` as 0 would compile a wrong range instead of reporting it. Absent
    // entirely is still fine — that is what defaults to 0.
    if (from && from.kind !== "dynamic" && from.kind !== "static") {
      // A spread (`...obj`) carries no attribute name, so it has no
      // `nameRange` to point at; its whole range is the best position.
      fail(
        "`<for from=...>` requires an expression value",
        "nameRange" in from ? from.nameRange : from.range,
      );
    }
    const hasFrom = from !== undefined;
    const fromExpr = from
      ? subParseNode(ctx, from.value, "for `from` expression")
      : numericLiteral(ctx, 0, el.range);
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
    const count = countExpression(
      ctx,
      fromExpr,
      boundExpr,
      to !== undefined,
      el.range,
    );
    // Only pass `from` when the author wrote it; `Repeat`'s default is 0.
    return repeatElement(
      ctx,
      count,
      hasFrom ? fromExpr : null,
      params,
      body,
      el.range,
    );
  }

  fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", el.name);
}

/**
 * `<try>` -> `<Errored fallback={(e, reset) => ...}><Loading fallback={...}>
 * ...</Loading></Errored>` (spec section 5.3).
 *
 * `<@catch|e|>` and `<@catch|e, reset|>` are both accepted: `Errored`'s
 * fallback signature exposes `reset` as a second parameter, and declaring it
 * is the author's choice. `<@placeholder>` is optional; without it the
 * `<Loading>` boundary still wraps the body, since a body that suspends
 * should show nothing rather than fall through to the error branch.
 */
export function lowerTry(ctx: LowerContext, el: MxElement): Node {
  if (el.params) fail("tag params (`|a, b|`) on `<try>`", el.params);

  let catchBody: Node | null = null;
  let catchParams: unknown[] | null = null;
  let catchRange: MxRange | null = null;
  let placeholderBody: Node | null = null;
  let placeholderRange: MxRange | null = null;
  const rest: MxChild[] = [];

  for (const child of el.children) {
    if (child.kind !== "element") {
      rest.push(child);
      continue;
    }
    const name = child.element.staticName;
    if (name === "@catch") {
      if (catchBody !== null) fail("duplicate `<@catch>`", child.element.name);
      catchParams = child.element.params
        ? tagParams(ctx, child.element.params)
        : null;
      catchBody = lowerBody(ctx, child.element);
      catchRange = child.element.range;
      continue;
    }
    if (name === "@placeholder") {
      if (placeholderBody !== null) {
        fail("duplicate `<@placeholder>`", child.element.name);
      }
      placeholderBody = lowerBody(ctx, child.element);
      placeholderRange = child.element.range;
      continue;
    }
    rest.push(child);
  }

  const bodyChildren = lowerChildrenNodes(ctx, rest);

  const loadingAttrs: Node[] = [];
  if (placeholderBody) {
    loadingAttrs.push(
      exprAttribute(
        ctx,
        "fallback",
        placeholderBody,
        placeholderRange ?? el.range,
      ),
    );
  }
  const loading = jsxElement(
    ctx,
    "Loading",
    loadingAttrs,
    bodyChildren,
    el.range,
  );

  if (!catchBody) {
    // No `<@catch>` means there is no error branch to build an `Errored`
    // boundary from; the `<Loading>` boundary alone is the whole lowering.
    return loading;
  }

  const erroredAttrs: Node[] = [
    exprAttribute(
      ctx,
      "fallback",
      (
        callbackChild(
          ctx,
          catchParams ?? [],
          catchBody,
          catchRange ?? el.range,
        ) as { expression: Node }
      ).expression,
      catchRange ?? el.range,
    ),
  ];

  return jsxElement(ctx, "Errored", erroredAttrs, [loading], el.range);
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
