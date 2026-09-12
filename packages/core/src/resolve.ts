/**
 * The resolver (decision 79): Marko's AST in, MX's host-independent IR out.
 *
 * This is the core's whole node walk, with every `out +=` removed. It does all
 * the validation the emitting walk used to do — dispositions and inert shapes,
 * the field guard, `checkBinding`, the four `<for>` forms, if-chain grouping,
 * attribute-tag collection, statement-tag hoisting — and produces `IrNode`s
 * instead of text. A host then emits from the IR and never sees a Marko node.
 *
 * Error messages and positions are preserved **byte for byte** from the
 * emitting walk: `packages/hosts/html`'s error fixtures and the oracle's error
 * class both assert them, and a reworded message is a behaviour change even
 * when the construct is still rejected.
 *
 * ## The two decision-70 hooks, as IR annotations
 *
 * `ctx.hoist(code)` and `ctx.bindings` still exist, and still run *here*
 * rather than at emit time: both are resolve-time state. A hoisted statement
 * is recorded on the enclosing scope (the template's `prelude`, or the nearest
 * `Define`'s own), and a registered binding rewrites identifier *references*
 * as each expression is printed — so the `Expr.code` a host receives is
 * already rewritten and an emitter stays dumb. Shadowing is applied as the
 * walk enters and leaves each binding construct, exactly as before.
 */

import {
  attrByName,
  bindingIdentifiers,
  type Ctx,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  hasContent,
  importBindings,
  type Node,
  rejectInertShape,
  rejectUnsupportedFields,
  scopeBindings,
  shadowBindings,
  sliceLoc,
  VOID_TAGS,
} from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  ComponentTarget,
  Expr,
  ExprShape,
  ForSource,
  Ir,
  IrNode,
  Position,
} from "./ir.ts";

/** A node's start position, in `TranslateError`'s own 1-based/0-based shape. */
function posOf(node: Node): Position {
  const start = node?.loc?.start ?? node?.start ?? {};
  return { line: start.line ?? 0, column: start.column ?? 0 };
}

/** A node's end position, paired with `posOf` for source-backed code blocks. */
function endPosOf(node: Node): Position {
  const end = node?.loc?.end ?? node?.end ?? {};
  return { line: end.line ?? 0, column: end.column ?? 0 };
}

/** Classifies an expression once, while its parsed node is still available. */
export function expressionShape(node: Node): ExprShape {
  switch (node?.type) {
    case "ObjectExpression":
      return "object";
    case "ArrayExpression":
      return "array";
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    default:
      return "other";
  }
}

/** An expression, printed and classified through the binding registry. */
function exprOf(ctx: Ctx, node: Node): Expr {
  if (node?.type === "MarkoParseError") {
    fail(node.label ?? "invalid expression", {
      loc: { start: node.errorLoc?.start ?? node.loc?.start },
    });
  }
  return { code: expr(ctx, node), shape: expressionShape(node), node };
}

/**
 * Where hoisted statements accumulate for the function currently being
 * resolved.
 *
 * `ctx.prelude` is swapped as the walk enters and leaves a `<define>`, so a
 * `ctx.hoist` from inside one lands on that define's own head rather than the
 * render function's — the same function-boundary rule the resolver applies to
 * the template body.
 */
function withPrelude<T>(ctx: Ctx, run: () => T): [T, Ctx["prelude"]] {
  const outer = ctx.prelude;
  ctx.prelude = [];
  const result = run();
  const prelude = ctx.prelude;
  ctx.prelude = outer;
  return [result, prelude];
}

/** Resolves one attribute of an element or component call. */
function resolveAttr(
  ctx: Ctx,
  attr: Node,
  on: "element" | "component" = "element",
): Attr {
  const loc = posOf(attr);

  if (attr.type === "MarkoSpreadAttribute") {
    return { kind: "spread", value: exprOf(ctx, attr.value), loc };
  }

  if (attr.arguments || attr.value?.type === "FunctionExpression") {
    if (ctx.declarations.resolveAttributeMethod?.(attr, on) !== true) {
      ctx.declarations.rejectAttributeMethod?.(attr, on);
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
        attr,
      );
    }
  }

  if (attr.bound) {
    return {
      kind: "bound",
      name: attr.name,
      value: exprOf(ctx, attr.value),
      loc,
    };
  }

  // `class:foo="x"` is a modifier Marko hands over as a base name plus a
  // modifier. Emitting only the base name renders `class="x"` — not a drop but
  // a *wrong* attribute, which is worse. The host gets first refusal so the
  // diagnostic is in its own vocabulary (a Marko-parity target quotes Marko's
  // own fix-it); the core's wording is only the fallback.
  if (attr.modifier) {
    const resolvedName = ctx.declarations.resolveModifier?.(attr, on);
    if (resolvedName !== undefined) {
      return {
        kind: "dynamic",
        name: resolvedName,
        value: exprOf(ctx, attr.value),
        loc,
      };
    }
    // The tag kind travels with the rejection: a modifier on a *component*
    // call is a different diagnostic from one on an element, and the pre-IR
    // walk said so ("… on a component call is not supported"). Losing that
    // distinction was a message regression even though both still fail.
    ctx.declarations.rejectModifier?.(attr, on);
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
      attr,
    );
  }

  const value = attr.value;
  // A bare attribute (`download`, `checked`) is HTML's spelling of `true`.
  if (value?.type === "BooleanLiteral" && value.value === true) {
    return { kind: "boolean", name: attr.name, loc };
  }
  if (value?.type === "StringLiteral") {
    return { kind: "static", name: attr.name, value: value.value, loc };
  }
  return { kind: "dynamic", name: attr.name, value: exprOf(ctx, value), loc };
}

function resolveAttrs(
  ctx: Ctx,
  node: Node,
  name: string,
  on: "element" | "component" = "element",
): Attr[] {
  const attrs = (node.attributes ?? []).map((attr: Node) =>
    resolveAttr(ctx, attr, on),
  );
  return ctx.declarations.orderAttrs?.(name, attrs, on, ctx) ?? attrs;
}

/** The tag params of `<for|a, b|>` / `<@name|p|>`, as source text. */
function paramsOf(ctx: Ctx, node: Node): string[] {
  return (node.body?.params ?? []).map((p: Node) => {
    // Babel's generator omits a TypeScript annotation when an Identifier is
    // printed outside its parameter-list context. The Marko node's location
    // covers the complete authored pattern, so use that exact source text for
    // params and preserve annotations as well as destructuring.
    const source = p.loc ? sliceLoc(ctx, p.loc) : "";
    return source || declName(ctx, p);
  });
}

/** Marko keeps non-empty params as nodes but represents both absent and `||` as `[]`. */
function hasParams(ctx: Ctx, node: Node): boolean {
  if ((node.body?.params ?? []).length > 0) return true;
  const source = sliceLoc(ctx, node.loc);
  const openEnd = source.indexOf(">");
  return (openEnd < 0 ? source : source.slice(0, openEnd)).includes("||");
}

/** Every name a tag's params bind, for shadowing. */
function paramBindings(node: Node): string[] {
  return (node.body?.params ?? []).flatMap((p: Node) => bindingIdentifiers(p));
}

/**
 * A child list resolved as a callable block, with its params shadowing.
 *
 * A block's params are in scope for its own body only: inside
 * `<@footer|year|>`, `year` is the parameter, not any host binding of the same
 * name. Restored on the way out.
 */
function resolveBlock(ctx: Ctx, node: Node): Block {
  // A block is its own JS scope: both the params it shadows *and* anything a
  // `<const>` inside it unregisters are confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(node));
  const children = resolveChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();
  return {
    hasParams: hasParams(ctx, node),
    params: paramsOf(ctx, node),
    children,
    loc: posOf(node),
  };
}

/** `<@name>` children of a component call, in source order. */
function resolveAttributeTags(ctx: Ctx, node: Node): AttributeTag[] {
  const tags: AttributeTag[] = [];
  for (const block of node.attributeTags ?? []) {
    if (block.type !== "MarkoTag") continue;
    tags.push({
      name: String(block.name.value).replace(/^@/, ""),
      block: resolveBlock(ctx, block),
      loc: posOf(block),
    });
  }
  return tags;
}

/**
 * `<if>` plus any `<else if>`/`<else>` siblings, grouped into one node.
 *
 * Returns the index of the first sibling it did not consume, so the caller
 * resumes after the whole chain rather than re-reading `<else>` as a tag.
 */
function resolveIfChain(
  ctx: Ctx,
  children: Node[],
  index: number,
): [IrNode, number] {
  const node = children[index];
  rejectUnsupportedFields(ctx, node, "`<if>`");
  const cond = attrByName(node, "value") ?? node.attributes?.[0];
  if (!cond?.value) fail("`<if>` without a condition", node);

  // Each branch is its own JS block: a `<const>` declared inside one does not
  // shadow the host's binding for the code that follows the chain.
  const branchChildren = (branchNode: Node): IrNode[] => {
    const unscope = scopeBindings(ctx);
    const children = resolveChildren(ctx, branchNode.body?.body ?? []);
    unscope();
    return children;
  };

  const branches: Branch[] = [
    {
      condition: exprOf(ctx, cond.value),
      children: branchChildren(node),
      loc: posOf(node),
    },
  ];

  let i = index + 1;
  while (i < children.length) {
    const child = children[i];
    // Whitespace and comments between branches are layout, not content.
    if (child.type === "MarkoComment") {
      i++;
      continue;
    }
    if (child.type === "MarkoText" && child.value.trim() === "") {
      i++;
      continue;
    }
    const childName = child.name?.value;
    if (
      child.type !== "MarkoTag" ||
      (childName !== "else" && childName !== "else-if")
    ) {
      break;
    }

    rejectUnsupportedFields(ctx, child, `\`<${childName}>\``);
    // `<else if=cond>` spells the condition as an `if` attribute; Marko's own
    // `<else-if=cond>` spells it as the tag's first (value) attribute.
    const ifAttr =
      childName === "else-if"
        ? (attrByName(child, "value") ?? child.attributes?.[0])
        : attrByName(child, "if");
    branches.push({
      condition: ifAttr ? exprOf(ctx, ifAttr.value) : null,
      children: branchChildren(child),
      loc: posOf(child),
    });
    i++;
    if (!ifAttr) break;
  }

  return [{ kind: "IfChain", branches, loc: posOf(node) }, i];
}

/**
 * All of `<for>`'s forms, normalized to the three a host emits.
 *
 * `by=` names which item a DOM node belongs to across re-renders. A one-shot
 * string host has no reconciliation, so it safely ignores the field (decision
 * 65). A reactive host (Solid) emits it as the `keyed` prop on `<For>`.
 * Carried in the IR so both paths work from the same tree.
 */
function resolveFor(ctx: Ctx, node: Node): IrNode {
  rejectUnsupportedFields(ctx, node, "`<for>`", { params: true });

  const params = paramsOf(ctx, node);
  // A `<for>` with no params names no loop variable. Defaulting it to `item`
  // would bind the body to a name the author never wrote — resolving to an
  // outer-scope `item` if one exists, or failing at render time instead of
  // compile time.
  if (params.length === 0) {
    fail("`<for>` needs tag params: `<for|item| of=…>`", node);
  }

  // The iterable is evaluated *outside* the loop, so a registered name there is
  // still the host's binding; only the body is shadowed by the params.
  const of = attrByName(node, "of");
  const inAttr = attrByName(node, "in");
  const to = attrByName(node, "to");
  const until = attrByName(node, "until");
  const step = attrByName(node, "step");
  const by = attrByName(node, "by");

  const combos = [of, inAttr, attrByName(node, "from") || to || until].filter(
    Boolean,
  ).length;
  if (combos > 1) {
    fail(
      "`<for>` with more than one of `of=`, `in=`, `from=`/`to=`/`until=`",
      node,
    );
  }
  if (to && until) fail("`<for>` with both `to=` and `until=`", node);
  if (step && !(to || until)) {
    fail("`<for step=...>` is only valid on a range", step);
  }

  const requireValue = (attr: Node | undefined, label: string): void => {
    if (
      attr &&
      (!attr.value?.loc ||
        attr.arguments ||
        attr.value.type === "FunctionExpression")
    ) {
      fail(`\`<for ${label}=...>\` requires an expression value`, attr);
    }
  };
  requireValue(of, "of");
  requireValue(inAttr, "in");
  requireValue(attrByName(node, "from"), "from");
  requireValue(to, "to");
  requireValue(until, "until");
  requireValue(step, "step");
  requireValue(by, "by");

  let source: ForSource;
  if (of) {
    source = { kind: "of", list: exprOf(ctx, of.value) };
  } else if (inAttr) {
    source = { kind: "in", object: exprOf(ctx, inAttr.value) };
  } else if (to || until) {
    const from = attrByName(node, "from");
    source = {
      kind: "range",
      from: from ? exprOf(ctx, from.value) : null,
      bound: exprOf(ctx, (to ?? until).value),
      inclusive: Boolean(to),
      step: step ? exprOf(ctx, step.value) : null,
    };
  } else {
    fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
  }

  const bindings = paramBindings(node);
  // The loop body is a JS block, so a `<const>` inside it is confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, bindings);
  const children = resolveChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();

  return {
    kind: "For",
    source,
    params,
    bindings,
    key: by ? exprOf(ctx, by.value) : null,
    children,
    loc: posOf(node),
  };
}

/** `<const/name=expr/>` — a binding at render scope. */
function resolveConst(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, "`<const>`", { var: true });
  // Dispatched by the core, before any host sees the tag, so the binding check
  // has to happen here or a host's rule would silently apply to `<let>` and not
  // to `<const>`.
  ctx.declarations.checkBinding?.(node.var, "`<const>`");
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  if (!value?.value) fail("`<const>` without a value", node);

  const name = declName(ctx, node.var);
  // The initializer is evaluated *before* the binding exists, so a registered
  // name on the right-hand side is still the host's: `<const/count=count + 1>`
  // resolves to `const count = count() + 1`. Shadowing takes effect only
  // afterwards, for the rest of the render scope.
  const init = exprOf(ctx, value.value);
  shadowBindings(ctx, bindingIdentifiers(node.var));

  return { kind: "Const", name, init, loc: posOf(node) };
}

/** `<define/name|params|>...</define>` — a reusable block. */
function resolveDefine(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  rejectUnsupportedFields(ctx, node, "`<define>`", { var: true, params: true });

  const name = declName(ctx, node.var);
  const params = paramsOf(ctx, node);

  // The params shadow the host's bindings inside the body only, and a
  // statement hoisted from inside belongs to *this* function's head — it may
  // read the define's own params.
  const restore = shadowBindings(ctx, paramBindings(node));
  const [children, prelude] = withPrelude(ctx, () =>
    resolveChildren(ctx, node.body?.body ?? []),
  );
  restore();

  ctx.defines.set(name, params);

  const loc = posOf(node);
  const hoisted: IrNode[] = prelude.map(({ code, node }) => ({
    kind: "Hoisted" as const,
    code,
    loc: posOf(node),
    end: endPosOf(node),
  }));
  return {
    kind: "Define",
    name,
    params,
    children: [...hoisted, ...children],
    loc,
  };
}

/**
 * Statement tags, recovered from source and hoisted to module scope.
 *
 * `import` reaches module scope verbatim; `static` drops its keyword; `export
 * interface Input` is lifted so a host can place it above the render function;
 * any other `export` hoists verbatim as a real module export.
 */
function resolveStatement(ctx: Ctx, node: Node, name: string): IrNode {
  const line = sliceLoc(ctx, node.loc).trim();
  const loc = posOf(node);
  const end = endPosOf(node);

  if (name === "import") {
    const bindings = importBindings(line);
    // Recorded *now*, not in `resolve`'s post-pass: a component call later in
    // the body asks `isComponent`, which consults `ctx.imports`, so a binding
    // registered only after the whole body resolved would make every
    // imported component an unbound capitalized tag.
    for (const binding of bindings) ctx.imports.add(binding);
    return { kind: "Import", code: line, bindings, loc, end };
  }
  if (name === "static") {
    return {
      kind: "Static",
      code: line.replace(/^static\s+/, ""),
      loc,
      end,
    };
  }
  if (/^export\s+interface\s+Input\b/.test(line)) {
    return { kind: "InputInterface", code: line, loc, end };
  }
  if (name === "export") {
    return { kind: "Export", code: line, loc, end };
  }
  fail(
    `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\``,
    node,
  );
}

/** A tag this host claims, with every part resolved for its emitter. */
function resolveHostTag(ctx: Ctx, node: Node, name: string): IrNode {
  const loc = posOf(node);
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(node));
  const children = resolveChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();

  return {
    kind: "HostTag",
    tag: {
      name,
      attrs: resolveAttrs(ctx, node, name),
      children,
      attributeTags: resolveAttributeTags(ctx, node),
      params: paramsOf(ctx, node),
      var: node.var ? declName(ctx, node.var) : null,
      data: ctx.declarations.resolveHostTag?.(name, node, ctx),
      loc,
    },
    loc,
  };
}

/** A component call, with its props, children and attribute tags. */
function resolveComponent(
  ctx: Ctx,
  node: Node,
  target: ComponentTarget,
): IrNode {
  // The host gets first refusal, before any `Component` node exists: a call it
  // will not route must fail here rather than reach an emitter, which no
  // longer has the Marko node to judge it by.
  if (target.kind === "name") {
    ctx.declarations.rejectComponentTag?.(target.name, node, ctx);
  }
  rejectUnsupportedFields(ctx, node, `\`<${targetName(target)}>\``, {
    attributeTags: true,
    args: true,
    params: true,
  });

  const parentAttrs = new Set(
    (node.attributes ?? [])
      .filter((attr: Node) => attr.type !== "MarkoSpreadAttribute")
      .map((attr: Node) => attr.name),
  );
  const seenTags = new Set<string>();
  for (const tag of node.attributeTags ?? []) {
    const name = String(tag.name?.value ?? "").replace(/^@/, "");
    if (parentAttrs.has(name)) {
      fail(
        `attribute tag \`@${name}\` collides with attribute \`${name}\``,
        tag,
      );
    }
    if (name === "children" && hasContent(node.body?.body ?? [])) {
      fail(
        "attribute tag `@children` collides with the parent's ordinary children",
        tag,
      );
    }
    seenTags.add(name);
    if ((tag.attributes ?? []).length > 0) {
      fail("attribute tags take params or a body, not attributes (v1)", tag);
    }
    if ((tag.attributeTags ?? []).length > 0) {
      const inner = tag.attributeTags[0];
      const innerName = String(inner.name?.value ?? "");
      fail(
        `attribute tag \`<${innerName}>\` inside attribute tag \`<@${name}>\``,
        inner,
      );
    }
  }

  const children = node.body?.body ?? [];
  return {
    kind: "Component",
    target,
    attrs: resolveAttrs(ctx, node, targetName(target), "component"),
    content: hasContent(children) ? resolveBlock(ctx, node) : null,
    attributeTags: resolveAttributeTags(ctx, node),
    args: (node.arguments ?? []).map((a: Node) => exprOf(ctx, a)),
    loc: posOf(node),
  };
}

function targetName(target: ComponentTarget): string {
  // A dynamic target has no name to report, so the diagnostic names the
  // construct instead. Spelled without a `$`-brace so it is not mistaken for
  // an unintended template placeholder in this file's own source.
  return target.kind === "dynamic" ? "dynamic tag" : target.name;
}

function resolveTag(ctx: Ctx, node: Node): IrNode {
  // A bare `${expr}` on its own line parses as a tag whose *name* is the
  // expression, with no attributes and no body — Marko's concise mode has no
  // other shape for it. Treated as the escaped placeholder the author wrote.
  if (node.name && node.name.type !== "StringLiteral") {
    const claimed = ctx.declarations.claimsTag?.(DYNAMIC_TAG, ctx);
    if ((node.attributes ?? []).length === 0 && !node.body?.body?.length) {
      if (claimed) return resolveHostTag(ctx, node, DYNAMIC_TAG);
      return {
        kind: "Interpolation",
        expr: exprOf(ctx, node.name),
        escaped: true,
        loc: posOf(node),
      };
    }
    if (claimed) return resolveHostTag(ctx, node, DYNAMIC_TAG);
    fail("dynamic tag name is not supported in a standalone template", node);
  }

  const name = String(node.name.value);

  const disposition = ctx.declarations.tags[name];
  if (disposition) {
    if (disposition.kind === "error") fail(disposition.reason, node);
    rejectInertShape(ctx, node, name, disposition);
    // Inert: accepted, contributes nothing to the IR.
    return { kind: "Text", value: "", loc: posOf(node) };
  }

  switch (name) {
    case "import":
    case "static":
    case "export":
      return resolveStatement(ctx, node, name);
    case "for":
      return resolveFor(ctx, node);
    case "const":
      return resolveConst(ctx, node);
    case "define":
      return resolveDefine(ctx, node);
    case "else": {
      const label = attrByName(node, "if") ? "else if" : "else";
      return fail(`\`<${label}>\` without a preceding \`<if>\``, node);
    }
    case "else-if":
      return fail(`\`<${name}>\` without a preceding \`<if>\``, node);
  }

  if (ctx.declarations.claimsTag?.(name, ctx)) {
    return resolveHostTag(ctx, node, name);
  }

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      node,
    );
  }

  if (ctx.declarations.isComponent(name, ctx)) {
    const params = ctx.defines.get(name);
    return resolveComponent(
      ctx,
      node,
      params ? { kind: "define", name, params } : { kind: "name", name },
    );
  }

  // No HTML element is ever capitalized, so an unbound PascalCase tag is a
  // missing or misspelled binding, not an element that happens to be
  // capitalized. Emitting it literally would be a silent misroute.
  if (/^[A-Z]/.test(name)) {
    fail(
      `\`<${name}>\` has no matching import or \`<define>\` in scope; a capitalized tag is always a component call`,
      node,
    );
  }

  // An unknown lowercase tag that is neither a binding nor a real element is
  // the silent-failure mode ADR 0001 names: a core tag the host has no
  // lowering for must be an error, never a literal element.
  if (!ctx.declarations.isElement(name, ctx)) {
    // The host's own wording first: a Marko-parity target reports Marko's
    // failure for an unresolved custom tag, which is what its users see and
    // what the fixtures assert. The message below is the fallback.
    ctx.declarations.rejectUnknownTag?.(name, node, ctx);
    fail(
      `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }

  if (node.attributeTags?.length) {
    ctx.declarations.rejectElementAttributeTags?.(name, node, ctx);
  }
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``);

  const isVoid = VOID_TAGS.has(name);
  return {
    kind: "Element",
    name,
    attrs: resolveAttrs(ctx, node, name),
    children: isVoid ? [] : resolveChildren(ctx, node.body?.body ?? []),
    void: isVoid,
    loc: posOf(node),
  };
}

export function resolveChildren(ctx: Ctx, children: Node[]): IrNode[] {
  const out: IrNode[] = [];
  let index = 0;

  while (index < children.length) {
    const child = children[index];

    if (child.type === "MarkoTag" && child.name?.value === "if") {
      const [node, next] = resolveIfChain(ctx, children, index);
      out.push(node);
      index = next;
      continue;
    }

    // A hoist from this child belongs to the enclosing function, so the
    // prelude it appends is drained by whichever scope owns it — the template,
    // or the nearest `<define>`.
    switch (child.type) {
      case "MarkoText":
        // Already decision 33: Marko's own `onText` dropped newline-bearing
        // whitespace runs and collapsed the rest before we saw them.
        out.push({ kind: "Text", value: child.value, loc: posOf(child) });
        break;
      case "MarkoPlaceholder":
        out.push({
          kind: "Interpolation",
          expr: exprOf(ctx, child.value),
          escaped: child.escape,
          loc: posOf(child),
        });
        break;
      case "MarkoTag":
        // A statement the host hoisted stays on `ctx.prelude` and is drained
        // by the enclosing *function* — `resolveDefine`, or `resolve` for the
        // render function — never here. Draining it at every child list would
        // trap a hoist from inside an `<if>` in that branch, which is the one
        // thing decision 70's hoist hook exists to prevent: the declaration
        // has to outlive the block it was written in.
        out.push(resolveTag(ctx, child));
        break;
      case "MarkoDocumentType":
        out.push({
          kind: "DocumentType",
          value: child.value,
          loc: posOf(child),
        });
        break;
      case "MarkoComment":
        // Marko strips the delimiters, so an HTML comment and a `//` line
        // comment are indistinguishable by value alone; the source decides.
        out.push({
          kind: "Comment",
          value: child.value,
          html: sliceLoc(ctx, child.loc).startsWith("<!--"),
          loc: posOf(child),
        });
        break;
      case "MarkoScriptlet":
        fail(
          "scriptlets (`$ statement`) are not supported in MX (decision 54)",
          child,
        );
        break;
    }
    index++;
  }

  return out;
}

/**
 * Resolves a whole template body to the IR.
 *
 * Module-level parts (`import`, `static`, `export interface Input`) are lifted
 * out of the body into `Ir`'s own fields, so a host places them without
 * filtering the tree for statement nodes.
 */
export function resolve(ctx: Ctx, body: Node[]): Ir {
  const [nodes, prelude] = withPrelude(ctx, () => resolveChildren(ctx, body));

  const ir: Ir = {
    imports: [],
    hoisted: [],
    inputInterface: null,
    prelude: prelude.map(({ code, node }) => ({
      kind: "Hoisted",
      code,
      loc: posOf(node),
      end: endPosOf(node),
    })),
    body: [],
  };

  for (const node of nodes) {
    switch (node.kind) {
      case "Import":
        // The bindings were registered as the statement resolved; this only
        // places the statement itself at module scope.
        ir.imports.push(node);
        break;
      case "Static":
        ir.hoisted.push(node);
        break;
      case "Export":
        ir.hoisted.push(node);
        break;
      case "InputInterface":
        ir.inputInterface = node;
        break;
      case "Hoisted":
        ir.prelude.push(node);
        break;
      default:
        ir.body.push(node);
    }
  }

  return ir;
}

export type { HostDeclarations };
