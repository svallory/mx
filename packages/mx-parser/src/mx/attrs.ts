import type { MxAttr, MxElement, MxRange } from "./walk.ts";

/**
 * Attribute-side lowering: spread, class/id shorthand, `class={}`/`style={}`
 * object routing, namespaced attributes, `ref`, `data-*`/`aria-*` pass-through,
 * and the `$!{}` sole-child innerHTML rule. Kept in its own module so the
 * parallel `lower-control` task's edits to the control-flow branch of the
 * lowering table merge cleanly against this one.
 */

/** Any Babel node; the vendored parser's internal node types are structural. */
type Node = Record<string, unknown>;

export interface AttrsContext {
  source: string;
  fail(construct: string, range: MxRange): never;
  subParse(range: MxRange, what: string): Node;
  at<T extends Node>(node: T, range: MxRange): T;
  jsxIdentifier(name: string, range: MxRange): Node;
}

/**
 * Namespaces Solid 2 removed, with the fix-it each one's replacement needs.
 *
 * `prop:` is deliberately absent: it is the one namespace that survives, so
 * it still passes through as a `JSXNamespacedName`. The rest have no target
 * in 2.0's JSX types at all — keeping them as pass-through syntax would emit
 * props the compiler silently ignores, so MX rejects them at parse time with
 * the replacement spelled out (decision 10).
 */
const REMOVED_NAMESPACES: Record<string, string> = {
  on: "`on:x=fn` was removed in Solid 2; use `onX=fn` for a delegated event, or a `ref` callback calling `addEventListener` for listener options",
  oncapture:
    "`oncapture:x=fn` was removed in Solid 2; use a `ref` callback calling `addEventListener(..., { capture: true })`",
  attr: "`attr:x=v` was removed in Solid 2; use the plain attribute `x=v`",
  bool: "`bool:x=v` was removed in Solid 2; use the plain attribute `x=v`",
  use: "`use:foo=opts` was removed in Solid 2; use `ref=foo(opts)` (a directive is now a function returning a ref callback)",
};

/**
 * Splits `prop:value` into a `JSXNamespacedName`'s namespace/name parts.
 *
 * Rejects a degenerate split: an empty namespace (`:foo`), an empty local
 * name (`prop:`), or a local name that itself contains a colon (`a:b:c`,
 * which would otherwise silently become namespace `a`, local `b:c`).
 */
function namespacedName(
  ctx: AttrsContext,
  name: string,
  nameRange: MxRange,
): Node {
  const colon = name.indexOf(":");
  const namespace = name.slice(0, colon);
  const local = name.slice(colon + 1);
  if (namespace === "" || local === "" || local.includes(":")) {
    ctx.fail(`malformed namespaced attribute \`${name}\``, nameRange);
  }
  const removed = REMOVED_NAMESPACES[namespace];
  if (removed) ctx.fail(removed, nameRange);
  const namespaceRange: MxRange = {
    start: nameRange.start,
    end: nameRange.start + namespace.length,
  };
  const localRange: MxRange = {
    start: nameRange.start + colon + 1,
    end: nameRange.end,
  };
  return ctx.at(
    {
      type: "JSXNamespacedName",
      namespace: ctx.jsxIdentifier(namespace, namespaceRange),
      name: ctx.jsxIdentifier(local, localRange),
    },
    nameRange,
  );
}

/** The `JSXIdentifier` or `JSXNamespacedName` for an attribute's name. */
export function attrNameNode(
  ctx: AttrsContext,
  name: string,
  nameRange: MxRange,
): Node {
  if (name.includes(":")) return namespacedName(ctx, name, nameRange);
  return ctx.jsxIdentifier(name, nameRange);
}

/** Wraps an already-lowered value expression in a `JSXExpressionContainer`. */
function exprAttr(
  ctx: AttrsContext,
  name: string,
  nameRange: MxRange,
  expression: Node,
  valueRange: MxRange,
  wholeRange: MxRange,
): Node {
  const container = ctx.at(
    { type: "JSXExpressionContainer", expression },
    valueRange,
  );
  return ctx.at(
    {
      type: "JSXAttribute",
      name: attrNameNode(ctx, name, nameRange),
      value: container,
    },
    wholeRange,
  );
}

/**
 * `class={a: on(), b: true}` / `class=someObj` / `style={color: c()}`.
 *
 * Detection is syntactic. Solid 2 removed `classList`: one `class` prop takes
 * a string, a `Record<string, boolean>`, or a recursive array of either, so an
 * `ObjectExpression` value stays on `class` instead of being renamed. `style`
 * always gets the double-brace container regardless of expression shape
 * (Solid accepts a plain object style with no rename).
 */
function lowerClassOrStyle(
  ctx: AttrsContext,
  attr: Extract<MxAttr, { kind: "dynamic" }>,
  hasShorthandClass: boolean,
  shorthandClassValue: string | null,
): Node {
  const expression = ctx.subParse(attr.value, "attribute value");

  if (attr.name === "style") {
    if (expression.type !== "ObjectExpression") {
      // Style values are always wrapped as an object container per the spec
      // table (`style={color: c()}` -> `style={{color: c()}}`); a non-object
      // style expression has no defined lowering yet.
      ctx.fail("`style=` with a non-object value", attr.value);
    }
    const wrapper = ctx.at(
      { type: "ObjectExpression", properties: [] },
      attr.value,
    );
    (wrapper as Node & { properties: unknown }).properties = (
      expression as unknown as { properties: unknown }
    ).properties;
    return exprAttr(ctx, attr.name, attr.nameRange, wrapper, attr.value, {
      start: attr.nameRange.start,
      end: attr.value.end,
    });
  }

  // attr.name === "class"
  if (expression.type === "ObjectExpression") {
    const wrapper = ctx.at(
      { type: "ObjectExpression", properties: [] },
      attr.value,
    );
    (wrapper as Node & { properties: unknown }).properties = (
      expression as unknown as { properties: unknown }
    ).properties;

    // Shorthand plus an object is no longer a conflict: `class` accepts an
    // array, so `<div.a.b class={c: on()}>` merges into `class={["a b",
    // {c: on()}]}` — the string entry is always-on, the object toggles.
    // Order matters (shorthand first) because later array entries win.
    const value: Node =
      hasShorthandClass && shorthandClassValue !== null
        ? ctx.at(
            {
              type: "ArrayExpression",
              elements: [
                ctx.at(
                  {
                    type: "StringLiteral",
                    value: shorthandClassValue,
                    extra: {
                      raw: `"${shorthandClassValue}"`,
                      rawValue: shorthandClassValue,
                    },
                  },
                  attr.value,
                ),
                wrapper,
              ],
            },
            attr.value,
          )
        : wrapper;

    return exprAttr(ctx, "class", attr.nameRange, value, attr.value, {
      start: attr.nameRange.start,
      end: attr.value.end,
    });
  }

  if (hasShorthandClass) {
    ctx.fail(
      "`.class` shorthand combined with a non-string `class={...}` value (combine shorthand with a string class or use class={...})",
      attr.value,
    );
  }

  return exprAttr(ctx, "class", attr.nameRange, expression, attr.value, {
    start: attr.nameRange.start,
    end: attr.value.end,
  });
}

/** `ref=el` -> `ref={el}`. The attr-method form (`ref(el) { ... }`) is handled by the generic method lowering in `lower.ts`. */
function lowerRef(
  ctx: AttrsContext,
  attr: Extract<MxAttr, { kind: "dynamic" }>,
): Node {
  const expression = ctx.subParse(attr.value, "attribute value");
  return exprAttr(ctx, "ref", attr.nameRange, expression, attr.value, {
    start: attr.nameRange.start,
    end: attr.value.end,
  });
}

/**
 * Lowers one non-spread, non-boolean, non-method, non-static attribute
 * (`kind: "dynamic"`), applying the `class`/`style`/`ref` special cases and
 * namespaced pass-through. Falls back to a plain `name={expr}` attribute.
 */
export function lowerDynamicAttr(
  ctx: AttrsContext,
  attr: Extract<MxAttr, { kind: "dynamic" }>,
  hasShorthandClass: boolean,
  shorthandClassValue: string | null = null,
): Node {
  if (attr.name === "class" || attr.name === "style") {
    return lowerClassOrStyle(ctx, attr, hasShorthandClass, shorthandClassValue);
  }
  if (attr.name === "ref") {
    return lowerRef(ctx, attr);
  }

  const expression = ctx.subParse(attr.value, "attribute value");
  return exprAttr(ctx, attr.name, attr.nameRange, expression, attr.value, {
    start: attr.nameRange.start,
    end: attr.value.end,
  });
}

/** `...expr` -> `JSXSpreadAttribute`. */
export function lowerSpreadAttr(
  ctx: AttrsContext,
  attr: Extract<MxAttr, { kind: "spread" }>,
): Node {
  const expression = ctx.subParse(attr.value, "spread attribute value");
  return ctx.at(
    { type: "JSXSpreadAttribute", argument: expression },
    attr.range,
  );
}

/**
 * Picks a quote character for a JSX string literal's raw form that does not
 * appear in `value` (JSX string literals have no backslash-escape syntax, so
 * the quote character itself must simply be avoided). Fails when the value
 * contains both quote characters, since there is then no quote that works.
 */
function quoteFor(ctx: AttrsContext, value: string, range: MxRange): '"' | "'" {
  if (!value.includes('"')) return '"';
  if (!value.includes("'")) return "'";
  ctx.fail(
    "merged `class` value contains both `\"` and `'`, which has no representable JSX string literal",
    range,
  );
}

/**
 * Builds the `class="card big[ x]"` static attribute from shorthand classes,
 * optionally merged with an explicit static `class="x"`.
 *
 * When there is an explicit `class="x"` to merge with, the merged attribute
 * is emitted at *that* attribute's position (name start through value end)
 * rather than at the shorthand's position: the shorthand is a tag-name
 * modifier with no attribute-list position of its own, so anchoring the
 * merged node there would place it before every attribute that precedes the
 * explicit `class=`, silently reordering it ahead of e.g. a spread that
 * should still be able to override it. With no explicit class to merge, the
 * shorthand's own range is the only position available.
 */
export function shorthandClassText(ctx: AttrsContext, el: MxElement): string {
  // Each range covers the leading `.`, e.g. `.card`; strip it for the value.
  return el.shorthandClasses
    .map((r) => ctx.source.slice(r.start + 1, r.end))
    .join(" ");
}

export function lowerShorthandClass(
  ctx: AttrsContext,
  el: MxElement,
  explicitStaticClass: Extract<MxAttr, { kind: "static" }> | null,
): Node {
  const shorthand = shorthandClassText(ctx, el);
  const shorthandRange = el.shorthandClasses[0] as MxRange;

  let value = shorthand;
  let raw = `"${shorthand}"`;
  let nameRange: MxRange = shorthandRange;
  let wholeRange: MxRange = shorthandRange;

  if (explicitStaticClass) {
    const explicitRaw = ctx.source.slice(
      explicitStaticClass.value.start,
      explicitStaticClass.value.end,
    );
    const explicitValue = explicitRaw.slice(1, -1);
    value = `${shorthand} ${explicitValue}`;
    nameRange = explicitStaticClass.nameRange;
    wholeRange = { start: nameRange.start, end: explicitStaticClass.value.end };
    const q = quoteFor(ctx, value, wholeRange);
    raw = `${q}${value}${q}`;
  }

  const literal = ctx.at(
    { type: "StringLiteral", value, extra: { raw, rawValue: value } },
    wholeRange,
  );
  return ctx.at(
    {
      type: "JSXAttribute",
      name: ctx.jsxIdentifier("class", nameRange),
      value: literal,
    },
    wholeRange,
  );
}

/** `<div#main>` -> `id="main"`. */
export function lowerShorthandId(ctx: AttrsContext, idRange: MxRange): Node {
  // The range covers the leading `#`, e.g. `#main`; strip it for the value.
  const value = ctx.source.slice(idRange.start + 1, idRange.end);
  const raw = `"${value}"`;
  const literal = ctx.at(
    { type: "StringLiteral", value, extra: { raw, rawValue: value } },
    idRange,
  );
  return ctx.at(
    {
      type: "JSXAttribute",
      name: ctx.jsxIdentifier("id", idRange),
      value: literal,
    },
    idRange,
  );
}
