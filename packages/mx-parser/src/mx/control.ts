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
export function wrapChildren(
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

export function elementChildrenRange(el: MxElement): MxRange {
  return childrenRange(el.children, el.range);
}

/**
 * The source span of a child list, or `fallback` when the list is empty.
 *
 * Taken over an explicit list rather than an element's own `children` because
 * a tag with both params and attribute tags needs the span of what actually
 * remains its body: the consumed `<@name>` children are no longer in it, and
 * measuring the original list would give the params callback a `loc` running
 * past its real body and into text belonging to a prop.
 */
export function childrenRange(children: MxChild[], fallback: MxRange): MxRange {
  if (children.length === 0) return fallback;
  const first = children[0] as MxChild;
  const last = children[children.length - 1] as MxChild;
  return { start: childRange(first).start, end: childRange(last).end };
}

function childRange(child: MxChild): MxRange {
  switch (child.kind) {
    case "text":
    case "placeholder":
    case "comment":
    // A doctype only occurs in a whole-file template, never inside a
    // `.solid.mx` expression, so this arm is unreachable from here — it is
    // listed to keep the switch exhaustive over `MxChild`.
    case "doctype":
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
export function callbackChild(
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
export function tagParams(ctx: LowerContext, params: MxRange): unknown[] {
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
  rejectAttributeTags(el, isElseIf ? "else if" : "if");
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
      rejectAttributeTags(el, "else");
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

/**
 * Numeric value of a node that is literally a number, else null. Includes
 * `-2`, which Babel parses as `UnaryExpression{operator: "-"}` over a
 * `NumericLiteral`, not a signed literal of its own — needed so a negative
 * `step=` still folds.
 */
function numericValueOf(node: Node): number | null {
  if (node.type === "NumericLiteral" && typeof node.value === "number") {
    return node.value;
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const inner = numericValueOf(node.argument as Node);
    return inner === null ? null : -inner;
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

/**
 * The iteration count for a stepped range `<for>`: `Math.floor((to - from) /
 * step) + 1` (inclusive) or `Math.ceil((until - from) / step)` (exclusive),
 * wrapped in `Math.max(0, …)` so a range that steps away from its bound (e.g.
 * `from=0 to=9 step=-1`) never hands `Repeat` a negative count.
 *
 * Folded to a literal only when `from`, the bound and `step` are all numeric
 * literals, matching `countExpression`'s rule for the unstepped case.
 */
function steppedCountExpression(
  ctx: LowerContext,
  from: Node,
  bound: Node,
  step: Node,
  inclusive: boolean,
  range: MxRange,
): Node {
  const fromValue = numericValueOf(from);
  const boundValue = numericValueOf(bound);
  const stepValue = numericValueOf(step);
  if (fromValue !== null && boundValue !== null && stepValue !== null) {
    const ratio = (boundValue - fromValue) / stepValue;
    const folded = inclusive ? Math.floor(ratio) + 1 : Math.ceil(ratio);
    return numericLiteral(ctx, Math.max(0, folded), range);
  }

  const difference = at(
    { type: "BinaryExpression", operator: "-", left: bound, right: from },
    ctx.source,
    range,
  );
  const ratio = at(
    { type: "BinaryExpression", operator: "/", left: difference, right: step },
    ctx.source,
    range,
  );
  const rounded = mathCall(ctx, inclusive ? "floor" : "ceil", [ratio], range);
  const count = inclusive
    ? at(
        {
          type: "BinaryExpression",
          operator: "+",
          left: rounded,
          right: numericLiteral(ctx, 1, range),
        },
        ctx.source,
        range,
      )
    : rounded;
  return mathCall(ctx, "max", [numericLiteral(ctx, 0, range), count], range);
}

/** `Math.<name>(...args)`. */
function mathCall(
  ctx: LowerContext,
  name: string,
  args: Node[],
  range: MxRange,
): Node {
  return at(
    {
      type: "CallExpression",
      callee: at(
        {
          type: "MemberExpression",
          object: at({ type: "Identifier", name: "Math" }, ctx.source, range),
          property: at({ type: "Identifier", name }, ctx.source, range),
          computed: false,
          optional: false,
        },
        ctx.source,
        range,
      ),
      arguments: args,
      optional: false,
    },
    ctx.source,
    range,
  );
}

/** Every `Identifier` name referenced anywhere in a subtree, for hygiene checks. */
function collectIdentifierNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifierNames(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "Identifier" && typeof record.name === "string") {
    out.add(record.name);
  }
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    collectIdentifierNames(record[key], out);
  }
}

/**
 * A name for the stepped range's raw counter that cannot clash with any
 * identifier the author's body already references: `mxIndex`, then
 * `mxIndex2`, `mxIndex3`, … on collision.
 */
function hygienicIndexName(body: Node): string {
  const used = new Set<string>();
  collectIdentifierNames(body, used);
  if (!used.has("mxIndex")) return "mxIndex";
  let n = 2;
  while (used.has(`mxIndex${n}`)) n++;
  return `mxIndex${n}`;
}

/**
 * `<Repeat count={…}>{(_k) => { const i = (from) + _k * (step); return body;
 * }}</Repeat>` — the stepped-range shape from decision 51/the `for-step`
 * brief. `i` keeps the author's own param name; `_k` is the hygienic raw
 * counter from `hygienicIndexName`. `from` is always emitted here (unlike the
 * unstepped `repeatElement`) because the callback body needs it whether or
 * not the author wrote it.
 *
 * **`from=`/`step=` are evaluated once per row, not once for the whole
 * range.** The `from`/`step` nodes passed in here are the *same* AST nodes
 * `steppedCountExpression` already embedded once in the `count` prop
 * expression, and they are embedded again in every row's callback body
 * (`indexInit` below) — `Repeat` invokes that callback once per row, so for
 * an N-row range `from`/`step` each evaluate N+1 times at runtime, not once.
 * A signal read or a literal is idempotent, so this is invisible for the
 * common case, but an impure `from=`/`step=` expression (a counter, a
 * logged call, anything with a side effect) silently runs N+1 times instead
 * of once — `<for|i| from=nextId() to=10 step=1>` calls `nextId()` eleven
 * times, not one. Authors must keep `from=`/`step=`/the bound pure (a
 * signal, a literal, or a memo), the same rule that already applies to any
 * JSX attribute value under Solid's own re-read-on-every-access model — see
 * `packages/mx-parser/README.md`'s `<for>` rows.
 */
function steppedRepeatElement(
  ctx: LowerContext,
  count: Node,
  from: Node,
  step: Node,
  param: Node,
  body: Node,
  range: MxRange,
): Node {
  const counterName = hygienicIndexName(body);
  const counterId = at(
    { type: "Identifier", name: counterName },
    ctx.source,
    range,
  );
  const stride = at(
    {
      type: "BinaryExpression",
      operator: "*",
      left: counterId,
      right: step,
    },
    ctx.source,
    range,
  );
  const indexInit = at(
    { type: "BinaryExpression", operator: "+", left: from, right: stride },
    ctx.source,
    range,
  );
  const indexDeclarator = at(
    { type: "VariableDeclarator", id: param, init: indexInit },
    ctx.source,
    range,
  );
  const indexDecl = at(
    {
      type: "VariableDeclaration",
      kind: "const",
      declarations: [indexDeclarator],
    },
    ctx.source,
    range,
  );
  const returnStmt = at(
    { type: "ReturnStatement", argument: body },
    ctx.source,
    range,
  );
  const blockBody = at(
    { type: "BlockStatement", body: [indexDecl, returnStmt], directives: [] },
    ctx.source,
    range,
  );
  const arrow = at(
    {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: false,
      params: [counterId],
      body: blockBody,
    },
    ctx.source,
    range,
  );
  const callbackChildNode = at(
    { type: "JSXExpressionContainer", expression: arrow },
    ctx.source,
    range,
  );
  const attributes: Node[] = [exprAttribute(ctx, "count", count, range)];
  return jsxElement(ctx, "Repeat", attributes, [callbackChildNode], range);
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
  rejectAttributeTags(el, "for");
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

    if (step) {
      if (step.kind !== "dynamic" && step.kind !== "static") {
        fail("`<for step=...>` requires an expression value", el.name);
      }
      const stepExpr = subParseNode(ctx, step.value, "for `step` expression");
      const stepValue = numericValueOf(stepExpr);
      if (stepValue === 0) {
        fail("`<for step=...>`: step must not be 0", el.name);
      }
      const singleParam = params[0] as Node;
      const count = steppedCountExpression(
        ctx,
        fromExpr,
        boundExpr,
        stepExpr,
        to !== undefined,
        el.range,
      );
      return steppedRepeatElement(
        ctx,
        count,
        fromExpr,
        stepExpr,
        singleParam,
        body,
        el.range,
      );
    }

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
 * One `<@name>` attribute tag, lowered to the value its prop will carry.
 *
 * `body` is the wrapped child list; `params` is the tag's `|p|` list when it
 * had one, so the caller can decide between `name={body}` and
 * `name={(p) => body}`. `lowerTry` needs the two halves apart — `Errored`'s
 * `fallback` is built by `callbackChild` there — so this returns them rather
 * than a finished attribute.
 */
export interface AttributeTag {
  /** The name without the `@`, i.e. the prop name. */
  name: string;
  body: Node;
  params: unknown[] | null;
  range: MxRange;
}

/**
 * Splits an element's children into its `<@name>` attribute tags and
 * everything else.
 *
 * The generic rule (decision 51) and `<try>`'s two special tags run through
 * this one function, so the two cannot drift: `<try>` reads `catch` and
 * `placeholder` out of the returned map and builds its own boundaries, while
 * every other tag turns each entry straight into a prop.
 *
 * Rejections live here for the same reason — an attribute tag carrying its
 * own attributes, written twice on one parent, or colliding with one of the
 * parent's own attributes, is reported identically wherever it appears.
 */
/**
 * True when an element has a child that will lower into its `children` prop:
 * any element that is not an attribute tag, or any non-whitespace text or
 * placeholder. Comments and whitespace-only text lower to nothing, so they do
 * not count.
 */
function hasOrdinaryChild(el: MxElement): boolean {
  return el.children.some((child) => {
    switch (child.kind) {
      case "comment":
        return false;
      case "text":
        return child.range.start !== child.range.end;
      case "element":
        return !child.element.staticName?.startsWith("@");
      default:
        return true;
    }
  });
}

export function collectAttributeTags(
  ctx: LowerContext,
  el: MxElement,
): { tags: AttributeTag[]; rest: MxChild[] } {
  const tags: AttributeTag[] = [];
  const rest: MxChild[] = [];
  const seen = new Set<string>();

  // The parent's own attribute names. An attribute tag lowers to a JSX
  // attribute, so a name already present here would emit the prop twice and
  // the last one would silently win.
  const parentAttrNames = new Set(
    el.attrs
      .filter((a) => "name" in a && a.name !== "")
      .map((a) => (a as { name: string }).name),
  );

  for (const child of el.children) {
    if (child.kind !== "element") {
      rest.push(child);
      continue;
    }
    const tagName = child.element.staticName;
    if (tagName === null || !tagName.startsWith("@")) {
      rest.push(child);
      continue;
    }

    const name = tagName.slice(1);
    if (parentAttrNames.has(name)) {
      fail(
        `attribute tag \`@${name}\` collides with attribute \`${name}\``,
        child.element.name,
      );
    }
    // `children` is the one prop the parent produces without an attribute of
    // that name: ordinary children lower into it. `<@children>` alongside any
    // ordinary child would therefore be a second producer of the same prop.
    if (name === "children" && hasOrdinaryChild(el)) {
      fail(
        "attribute tag `@children` collides with the parent's ordinary children",
        child.element.name,
      );
    }
    // Marko's repeatable attribute tags (which collect into an array prop)
    // are out of scope for v1; without this the second one would silently
    // win, which is the worse of the two behaviours.
    if (seen.has(name)) {
      fail(
        `attribute tag \`@${name}\` given twice (repeatable attribute tags are not supported)`,
        child.element.name,
      );
    }
    seen.add(name);

    // v1 keeps the prop value to exactly one of two shapes — the body, or a
    // function of the params. Attrs would mean a third (an object merging
    // them with `children`), which is a design decision this task does not
    // own, so they are rejected rather than guessed at.
    if (child.element.attrs.length > 0) {
      fail(
        "attribute tags take params or a body, not attributes (v1)",
        child.element.name,
      );
    }

    // An attribute tag's own body is an ordinary tag body, so a `<@name>`
    // nested directly inside one has no parent tag to become a prop of. It
    // reaches `lowerElement` and would otherwise be reported with the generic
    // "outside a tag body" message, which does not say where it actually sat.
    for (const inner of child.element.children) {
      if (inner.kind !== "element") continue;
      const innerName = inner.element.staticName;
      if (innerName?.startsWith("@")) {
        fail(
          `attribute tag \`<${innerName}>\` inside attribute tag \`<@${name}>\``,
          inner.element.name,
        );
      }
    }

    tags.push({
      name,
      body: lowerBody(ctx, child.element),
      params: child.element.params
        ? tagParams(ctx, child.element.params)
        : null,
      range: child.element.range,
    });
  }

  return { tags, rest };
}

/**
 * Rejects `<@name>` children on a control tag. `<if>`/`<for>` lower to Solid
 * shapes whose props MX chooses itself, so an author-named prop has nowhere
 * to go; `<try>` is the exception and consumes its two by name.
 */
export function rejectAttributeTags(el: MxElement, tag: string): void {
  for (const child of el.children) {
    if (child.kind !== "element") continue;
    const name = child.element.staticName;
    if (name?.startsWith("@")) {
      fail(
        `attribute tag \`<${name}>\` inside \`<${tag}>\``,
        child.element.name,
      );
    }
  }
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

  // `<@catch>`/`<@placeholder>` come through the generic attribute-tag
  // collector (decision 51), so their duplicate and attrs rejections are the
  // same code every other tag runs; `<try>` only decides where the two
  // resulting values go. Any *other* attribute tag is rejected below: `try`
  // lowers to `Errored`/`Loading`, whose remaining props MX owns.
  const { tags, rest } = collectAttributeTags(ctx, el);

  let catchTag: AttributeTag | null = null;
  let placeholderTag: AttributeTag | null = null;
  for (const tag of tags) {
    if (tag.name === "catch") {
      catchTag = tag;
      continue;
    }
    if (tag.name === "placeholder") {
      placeholderTag = tag;
      continue;
    }
    fail(`attribute tag \`<@${tag.name}>\` inside \`<try>\``, tag.range);
  }

  const catchBody = catchTag?.body ?? null;
  const catchParams = catchTag?.params ?? null;
  const catchRange = catchTag?.range ?? null;
  const placeholderBody = placeholderTag?.body ?? null;
  const placeholderRange = placeholderTag?.range ?? null;

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
  // A fragment has no element to carry props, so an attribute tag inside one
  // has no destination.
  rejectAttributeTags(el, "fragment");
  if (el.params) fail("tag params (`|a, b|`) on `<fragment>`", el.params);
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
