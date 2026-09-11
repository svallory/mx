/**
 * `@markox/translator`'s dialect policy: stock `.marko`, expressions-only.
 *
 * Decision 66. The lowering core is shared with `@markox/html`
 * (`@markox/html`'s `core.ts`); this file supplies only what differs, and
 * every difference is a property of *stock Marko's conventions* rather than a
 * preference:
 *
 * - **Attribute tags are renderables, not callable props.** Marko's own
 *   convention is that `<@header>` reaches the component as `input.header`,
 *   rendered with `<${input.header}/>`, and that a *repeated* attribute tag
 *   arrives as an array. Both verified against Marko 5.42.5's own server
 *   render, not assumed. `@markox/html` passes callable function props
 *   instead (S3); a translator that confused the two would compile happily
 *   and render the wrong markup.
 * - **Components are discovered**, through Marko's taglib lookup: an
 *   `import`, or a `tags/` directory beside the template. No explicit import
 *   is required, because requiring one is MX's convention and not Marko's.
 * - **Elements come from Marko's registry**, so a tag Marko adds or removes
 *   reaches this translator on a pin bump rather than through a hand-edited
 *   set — ADR 0001's entire point.
 *
 * The disposition table (decision 65) below is the interesting part. The test
 * for each construct is not "can this code lower it" but "does this target
 * emit bytes for it": a construct that only configures behaviour after the
 * first render is *inert* — accepted, with no output — and only a construct a
 * synchronous string render genuinely cannot express is an error.
 */

import {
  attrByName,
  blockFunction,
  type Ctx,
  type Disposition,
  DYNAMIC_TAG,
  emitChildren,
  emitExpression,
  emitLiteral,
  expr,
  fail,
  hasContent,
  type Node,
  type Policy,
  propKey,
  push,
  quote,
  rejectUnsupportedFields,
  sliceLoc,
} from "@markox/core";

export { TranslateError } from "@markox/core";

/**
 * The policy table of decision 65, as implemented.
 *
 * Inert entries were each verified against Marko's own server render: with
 * and without the construct, the emitted HTML is byte-identical. Error
 * entries are the two things a *synchronous* string function cannot express.
 */
const TAGS: Record<string, Disposition> = {
  // ---- inert: configures post-render behaviour, emits nothing ----
  //
  // Each row declares the shape the tag is inert *in*, taken from its own
  // Marko tag definition. Inert means the construct emits nothing; it never
  // means a body or an extra attribute may be discarded. Marko itself rejects
  // both (`<effect>` with a body is "does not support body content" there),
  // and the shapes below reproduce that.
  effect: {
    kind: "inert",
    reason:
      "`<effect>` runs after render, on the client; a server render emits nothing for it (verified against Marko's own html output)",
    body: "none",
    // Marko: `<effect foo="bar"/>` is "does not support the `foo` attribute",
    // and a spread is refused too. Only the `effect() { … }` call is its own.
    attributes: "none",
  },
  lifecycle: {
    kind: "inert",
    reason:
      "`<lifecycle>` is a client-side lifecycle hook; a server render emits nothing for it",
    // `openTagOnly` in Marko's definition, so a body is a parse error there
    // before a translator ever sees the node; rejected here too for the case
    // where a taglib does not carry that parse option.
    body: "none",
    // Marko accepts arbitrary attributes here (`<lifecycle foo="bar"/>`
    // compiles): a lifecycle tag's attributes *are* its configuration.
    attributes: "any",
  },
  script: {
    kind: "inert",
    reason:
      "`<script>` as a Marko tag is client-only behaviour, not markup; use `<html-script>` for a literal script element",
    // Marko declares `text: true`: the body is raw client-side script source,
    // genuinely consumed and genuinely emitting nothing. Verified: Marko's own
    // server render of `<script>console.log(1)</script>` emits no bytes.
    body: "text",
    attributes: "any",
  },
  id: {
    kind: "inert",
    reason:
      "`<id>` allocates a unique identifier for the reactive runtime; nothing is emitted for it here",
    body: "none",
    attributes: "none",
  },
  log: {
    kind: "inert",
    reason: "`<log>` writes to the console; it emits no markup",
    // `openTagOnly` in Marko, so a body is a parse error there first.
    body: "none",
    // Marko: `<log=1 foo="bar"/>` is refused; only the logged value is its own.
    attributes: "none",
  },
  debug: {
    kind: "inert",
    reason: "`<debug>` is a debugger hook; it emits no markup",
    body: "none",
    attributes: "none",
  },
  client: {
    kind: "inert",
    reason:
      "a `client` block is evaluated only on the client; a server render emits nothing for it",
    // A statement tag: its "attributes" are the statement's own words.
    body: "none",
    attributes: "any",
  },

  // ---- error: this target genuinely cannot express it ----
  await: {
    kind: "error",
    reason:
      "`<await>` suspends on a promise; this target is a synchronous `(input) => string` and cannot await. Marko itself refuses to render one to a string (\"Cannot consume asynchronous render with 'toString'\")",
  },
  return: {
    kind: "error",
    reason:
      "`<return>` provides a value to the *parent* template that rendered this one. A module compiled to `(input) => string` has no parent to return to — its only output is the string. Marko emits no markup for it either, so accepting it silently would read as support for something that cannot work here",
  },
};

/**
 * `<let>` and `<const>` bind a value at render scope.
 *
 * `<let>` is reactive state in full Marko, but its *initial value* is an
 * ordinary expression that Marko's own server render evaluates and renders
 * (`<let/count=5/>` then `${count}` emits `5`). Since there is no update path
 * in a one-shot render, binding it as a `const` reproduces Marko's output
 * exactly. This is decision 65's "evaluate initial value" row.
 */
function emitBinding(ctx: Ctx, node: Node, name: string): boolean {
  if (name !== "let" && name !== "const") return false;
  if (!node.var) {
    fail(
      `\`<${name}>\` without a variable name (write \`<${name}/x=1/>\`)`,
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, { var: true });
  rejectInputShadowing(node.var, `\`<${name}>\``);
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  // `<let/x/>` with no value is a declared-but-unset binding, which Marko
  // renders as the empty string. `<const/x/>` never reaches here — the core
  // switch dispatches `const` to `emitConst`, which requires a value, and
  // Marko itself refuses a valueless `<const>` ("requires a value").
  const init = value?.value ? expr(ctx, value.value) : "undefined";
  push(ctx, `const ${expr(ctx, node.var)} = ${init};`);
  return true;
}

/**
 * Rejects a binding that would shadow the render function's `input` parameter.
 *
 * The emitted module is `function (input: Input)`, so `<let/input=1/>` lowers
 * to `const input = 1` inside it — every later `${input.x}` then reads the
 * local, and the template's actual input becomes unreachable with no
 * diagnostic. Marko rejects the same thing outright ("Duplicate declaration of
 * `input`"), so this matches its outcome rather than inventing a rule.
 */
function rejectInputShadowing(target: Node, what: string): void {
  if (!bindingNames(target).includes("input")) return;
  fail(
    `\`input\` on ${what} collides with the template input parameter: the emitted render function takes \`input\`, so this binding would shadow it and make the template's own input unreachable`,
    target,
  );
}

/** Every identifier a binding pattern introduces. */
function bindingNames(pattern: Node): string[] {
  if (!pattern || typeof pattern !== "object") return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return (pattern.properties ?? []).flatMap((p: Node) =>
        bindingNames(p.value ?? p.argument),
      );
    case "ArrayPattern":
      return (pattern.elements ?? []).flatMap((e: Node) => bindingNames(e));
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
    default:
      return [];
  }
}

/**
 * Marko's own comment escaping, as `_escape_comment` implements it.
 *
 * Only `>` is escaped. `<`, `&` and quotes pass through raw — verified against
 * Marko's own render, both for static text and for an interpolated value. This
 * is not `escape()`: a comment is not markup, and over-escaping it would put
 * literal `&amp;` in the reader's comment.
 */
function escapeComment(text: string): string {
  return text.replace(/>/g, "&gt;");
}

/**
 * A component call, with Marko's own props convention.
 *
 * Attribute tags become *renderables*: `<@header>x</@header>` reaches the
 * component as `input.header`, and the component renders it with
 * `<${input.header}/>`. A renderable is represented here as a
 * `() => string` — the same shape `<${expr}/>` calls — so the two sides
 * agree. A *repeated* attribute tag becomes an array of them, which is what
 * Marko does and what lets a component write
 * `<for|it| of=input.item><${it}/></for>`.
 *
 * Ordinary children become `content`, not `children`: that is the prop name
 * Marko's own `<${input.content}/>` reads.
 */
function emitComponent(ctx: Ctx, node: Node, name: string): void {
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, {
    attributeTags: true,
    args: true,
  });

  const props = new Map<string, string>();
  const spreads: string[] = [];

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      spreads.push(expr(ctx, attr.value));
      continue;
    }
    if (attr.arguments) {
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler; it configures behaviour after render and has no place in a string render, but it is passed to the component untouched only when the component is a real Marko component — this target cannot`,
        attr,
      );
    }
    if (attr.bound) {
      // `:=` binds two ways in full Marko. A one-shot render has no update
      // path, so the *initial* value is what reaches the component — the
      // "evaluate initial value" row of decision 65.
      props.set(attr.name, expr(ctx, attr.value));
      continue;
    }
    if (attr.modifier) {
      fail(
        `attribute modifier \`${attr.name}:${attr.modifier}\` on a component call is not supported`,
        attr,
      );
    }
    const value = attr.value;
    if (value?.type === "BooleanLiteral" && value.value === true) {
      props.set(attr.name, "true");
    } else if (value?.type === "StringLiteral") {
      props.set(attr.name, quote(value.value));
    } else {
      props.set(attr.name, expr(ctx, value));
    }
  }

  // A repeated attribute tag is an array, exactly as Marko does it.
  const blocks = new Map<string, string[]>();
  for (const block of node.attributeTags ?? []) {
    if (block.type !== "MarkoTag") continue;
    const blockName = String(block.name.value).replace(/^@/, "");
    const params = (block.body?.params ?? [])
      .map((p: Node) => expr(ctx, p))
      .join(", ");
    const fn = blockFunction(ctx, block.body?.body ?? [], params);
    const existing = blocks.get(blockName);
    if (existing) existing.push(fn);
    else blocks.set(blockName, [fn]);
  }
  for (const [blockName, fns] of blocks) {
    props.set(
      blockName,
      fns.length === 1 ? (fns[0] as string) : `[${fns.join(", ")}]`,
    );
  }

  const children = node.body?.body ?? [];
  if (hasContent(children)) {
    props.set("content", blockFunction(ctx, children));
  }

  const defineParams = ctx.defines.get(name);
  if (defineParams) {
    if (spreads.length > 0) {
      fail(
        `spreading into \`<${name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
        node,
      );
    }
    // `<Row(input.a)/>` — Marko's tag-argument form, and the ordinary way to
    // call a `<define>` that declares params. The arguments are positional and
    // already parsed, so they pass straight through. Falling back to the
    // named-prop lookup keeps `<Row it=x/>` working for the same define.
    const args =
      node.arguments && node.arguments.length > 0
        ? node.arguments.map((argument: Node) => expr(ctx, argument))
        : defineParams.map((param) => props.get(param) ?? "undefined");
    push(ctx, `out += ${name}(${args.join(", ")});`);
    return;
  }

  const parts = [
    ...spreads.map((s) => `...${s}`),
    ...[...props].map(([key, value]) => `${propKey(key)}: ${value}`),
  ];
  push(ctx, `out += ${name}({ ${parts.join(", ")} });`);
}

/**
 * `<${expr}/>` — Marko's dynamic tag, and how a renderable is rendered.
 *
 * The value may be a component function, a renderable block, or a tag *name*
 * as a string. All three are resolved at run time by `renderDynamic`, which
 * is emitted into the module rather than imported, keeping the runtime
 * surface at exactly one helper (`escape`).
 */
function emitDynamicTag(ctx: Ctx, node: Node): void {
  const target = expr(ctx, node.name);
  const props = new Map<string, string>();
  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") continue;
    const value = attr.value;
    if (value?.type === "BooleanLiteral" && value.value === true) {
      props.set(attr.name, "true");
    } else if (value?.type === "StringLiteral") {
      props.set(attr.name, quote(value.value));
    } else {
      props.set(attr.name, expr(ctx, value));
    }
  }
  const children = node.body?.body ?? [];
  if (hasContent(children)) {
    props.set("content", blockFunction(ctx, children));
  }
  const parts = [...props].map(([key, value]) => `${propKey(key)}: ${value}`);
  push(ctx, `out += renderDynamic(${target}, { ${parts.join(", ")} });`);
}

/**
 * `<html-comment>text</html-comment>` -> a real HTML comment.
 *
 * Marko's plain `<!-- -->` comments are stripped from the output; this tag is
 * how a Marko author emits one that survives, so it lowers to the comment
 * itself.
 */
function emitSpecial(ctx: Ctx, node: Node, name: string): boolean {
  if (name === DYNAMIC_TAG) {
    emitDynamicTag(ctx, node);
    return true;
  }
  if (emitBinding(ctx, node, name)) return true;

  // A `server` block is server-side code, and this *is* the server render, so
  // it runs. Verified against Marko: `server const S = 41 + 1` followed by
  // `${S}` renders `42`. It hoists to module scope exactly as `static` does —
  // classifying it as inert (an earlier reading) would have silently dropped
  // a binding the rest of the template reads.
  if (name === "server") {
    const line = sliceLoc(ctx, node.loc).trim();
    ctx.hoisted.push(line.replace(/^server\s+/, ""));
    return true;
  }

  if (name === "html-comment") {
    rejectUnsupportedFields(ctx, node, "`<html-comment>`");
    emitLiteral(ctx, "<!--");
    for (const child of node.body?.body ?? []) {
      if (child.type === "MarkoText") {
        // A static run is escaped at compile time by the same rule, and
        // merged into the surrounding literal so a fully static comment stays
        // one `out +=`.
        emitLiteral(ctx, escapeComment(child.value));
      } else if (child.type === "MarkoPlaceholder") {
        // Filtering placeholders out (the previous behaviour) silently dropped
        // `<html-comment>build ${input.sha}</html-comment>` down to
        // `<!--build -->`. Marko lowers them, through its own
        // `_escape_comment`.
        push(ctx, `out += escapeComment(${expr(ctx, child.value)});`);
      } else if (child.type !== "MarkoComment") {
        fail(
          "`<html-comment>` takes only text and placeholders; a comment cannot contain markup",
          child,
        );
      }
    }
    emitLiteral(ctx, "-->");
    return true;
  }

  // `<html-script>`/`<html-style>` are Marko's spelling of a literal
  // `<script>`/`<style>` element, since the bare names are core tags.
  if (name === "html-script" || name === "html-style") {
    const tag = name.slice("html-".length);
    rejectUnsupportedFields(ctx, node, `\`<${name}>\``);
    push(ctx, `out += ${quote(`<${tag}>`)};`);
    for (const child of node.body?.body ?? []) {
      if (child.type === "MarkoText")
        push(ctx, `out += ${quote(child.value)};`);
      else if (child.type === "MarkoPlaceholder") {
        emitExpression(ctx, expr(ctx, child.value), child.escape);
      }
    }
    push(ctx, `out += ${quote(`</${tag}>`)};`);
    return true;
  }

  // `<style>` is a core tag in Marko (scoped styles); its body is raw text.
  if (name === "style") {
    rejectUnsupportedFields(ctx, node, "`<style>`");
    const text = (node.body?.body ?? [])
      .filter((c: Node) => c.type === "MarkoText")
      .map((c: Node) => c.value)
      .join("");
    push(ctx, `out += ${quote(`<style>${text}</style>`)};`);
    return true;
  }

  // `<try>` without a `<@placeholder>` is a plain try/catch: the body renders,
  // and `<@catch>` renders instead if it throws. A `<@placeholder>` needs a
  // second render pass over suspended content, which this target has no way to
  // schedule.
  if (name === "try") {
    const tags: Node[] = node.attributeTags ?? [];
    const placeholder = tags.find(
      (t: Node) => String(t.name?.value) === "@placeholder",
    );
    if (placeholder) {
      fail(
        "`<try>` with a `<@placeholder>` needs a second render pass over suspended content; a synchronous string render has nowhere to schedule it",
        placeholder,
      );
    }
    const katch = tags.find((t: Node) => String(t.name?.value) === "@catch");
    push(ctx, "try {");
    ctx.indent++;
    emitChildren(ctx, node.body?.body ?? []);
    ctx.indent--;
    if (katch) {
      const params = (katch.body?.params ?? [])
        .map((p: Node) => expr(ctx, p))
        .join(", ");
      push(ctx, `} catch (${params || "_error"}) {`);
      ctx.indent++;
      emitChildren(ctx, katch.body?.body ?? []);
      ctx.indent--;
      push(ctx, "}");
    } else {
      push(ctx, "} catch {}");
    }
    return true;
  }

  return false;
}

/**
 * Whether a tag name is an element, per Marko's own registry.
 *
 * `marko-html`, `marko-svg` and `marko-math` are the taglibs Marko loads for
 * HTML, SVG and MathML elements; anything they define is an element. A
 * hyphenated name is a custom element and always legal.
 */
const ELEMENT_TAGLIBS = new Set(["marko-html", "marko-svg", "marko-math"]);

function isElement(name: string, ctx: Ctx): boolean {
  if (name.includes("-")) return true;
  const taglibId = ctx.lookup?.getTag(name)?.taglibId;
  return taglibId !== undefined && ELEMENT_TAGLIBS.has(taglibId);
}

/**
 * Whether a tag name resolves to a component.
 *
 * An `import` binding or a `<define>` is one, as in `@markox/html`. So is a
 * tag Marko *discovered* — a `.marko` file in a `tags/` directory beside the
 * template — which is the convention this dialect exists to support and the
 * one MX's own dialect deliberately does not have.
 */
function isComponent(name: string, ctx: Ctx): boolean {
  if (ctx.defines.has(name) || ctx.imports.has(name)) return true;
  const taglibId = ctx.lookup?.getTag(name)?.taglibId;
  if (taglibId === undefined) return false;
  return !ELEMENT_TAGLIBS.has(taglibId) && taglibId !== "mx-translator-core";
}

/**
 * `class` and `style` take structured values in Marko, and render as a joined
 * string rather than as the value's own `String()` form.
 *
 * `class={a: true, b: false}` renders `class="a"`; `class=["x", {y: true}]`
 * renders `class="x y"`; `style={color: "red", top: 0}` renders
 * `style="color:red;top:0"`. All three measured against Marko's own server
 * render. Interpolating the raw value instead would emit `[object Object]` —
 * a silently wrong attribute rather than a visible failure.
 */
function attrValue(
  _ctx: Ctx,
  name: string,
  source: string,
): string | undefined {
  if (name === "class") return `classValue(${source})`;
  if (name === "style") return `styleValue(${source})`;
  return undefined;
}

/**
 * `value:=expr` binds two ways in full Marko: the initial value renders, and
 * later edits write back through the binding. A one-shot render has no write
 * path, so the initial value is the whole of it — decision 65's "evaluate
 * initial value" row, and exactly what Marko's own server render emits.
 */
function emitBoundAttr(ctx: Ctx, attr: Node): boolean {
  const source = attrValue(ctx, attr.name, expr(ctx, attr.value));
  emitLiteral(ctx, ` ${attr.name}="`);
  emitExpression(ctx, source ?? expr(ctx, attr.value), true);
  emitLiteral(ctx, '"');
  return true;
}

/**
 * `class:foo` / `style:foo` — rejected, with this dialect's own message.
 *
 * The brief asked for these to lower to Marko's semantics. Marko 5.42.5 /
 * `marko@6.3.51` has no such semantics to lower: its own parser rejects every
 * form of them outright —
 *
 *     `class:active` is not a valid attribute, did you mean
 *     `class={ active: condition }`?
 *
 * — for a static value, a dynamic value, alone, and combined with a plain
 * `class`. Verified against Marko's own compiler for `class:active`,
 * `class:big`, `style:color` (static and dynamic) and `class="base"
 * class:active=…`. Matching Marko therefore means *rejecting* them, and
 * inventing a lowering would be inventing markup the target does not have —
 * exactly what decision 65's table forbids. Recorded as a divergence from the
 * brief's expectation, not from Marko.
 *
 * A fixture is impossible for the same reason: no `.marko` file using this
 * syntax compiles through Marko, so there is nothing to compare against.
 *
 * The hook exists so the message is *this* dialect's. Without it the shared
 * core falls back to `@markox/html`'s wording ("not supported in a standalone
 * template"), which is `.mx`'s vocabulary leaking into a Marko-parity target.
 */
function emitModifier(_ctx: Ctx, attr: Node): boolean {
  fail(
    `\`${attr.name}:${attr.modifier}\` is not a valid attribute; Marko rejects this form too — write \`${attr.name}={ ${attr.modifier}: condition }\``,
    attr,
  );
}

/**
 * `<input value=…>` emits `value` before every other attribute, as Marko does.
 *
 * Not cosmetic and not Marko being arbitrary: a browser parsing
 * `<input type="checkbox" value="x">` applies `type` first, and for some
 * types that resets or reinterprets a `value` seen afterwards. Marko hoists
 * `value` so the parsed result matches the author's intent, and matching
 * Marko byte-for-byte is this package's whole claim, so the same hoist
 * happens here. Verified against Marko's own render:
 * `<input type="text" value=input.v disabled>` emits
 * `<input value=hello type=text disabled>`.
 */
function orderAttrs(tagName: string, attrs: Node[]): Node[] {
  if (tagName !== "input") return attrs;
  const index = attrs.findIndex(
    (a: Node) => a.type === "MarkoAttribute" && a.name === "value",
  );
  if (index <= 0) return attrs;
  const value = attrs[index] as Node;
  return [value, ...attrs.slice(0, index), ...attrs.slice(index + 1)];
}

export const policy: Policy = {
  tags: TAGS,
  isElement,
  isComponent,
  emitComponent,
  attrValue,
  checkBinding: rejectInputShadowing,
  emitBoundAttr,
  emitModifier,
  orderAttrs,
  escapeFrom: "@markox/translator",
  emitSpecial,
};

/**
 * Reactive constructs, rejected by name instead of rendering their initial
 * value or being treated as inert.
 *
 * Kept from `.mx`'s dialect (decision 68's policy fold) as an opt-in stance,
 * not the default: `policy.tags` renders `<let>`'s initial value and treats
 * `<effect>`/`<lifecycle>`/`<script>`/`<client>`/`<id>` as inert, matching
 * what Marko's own server render emits (decision 65). A `strict` author may
 * instead want a construct that only makes sense with a reactive runtime to
 * be a compile error, naming the construct, rather than silently accepted.
 * `<await>`/`<try>`-with-placeholder/`<return>` are errors in both policies
 * already — the target genuinely cannot express them — so only the
 * inert/initial-value rows change here.
 */
const STRICT_TAGS: Record<string, Disposition> = {
  ...TAGS,
  let: {
    kind: "error",
    reason:
      "`<let>` is reactive state and requires a runtime; this strict policy has no reactive target",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a reactive effect and requires a runtime; this strict policy has no reactive target",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; this strict policy has no reactive target",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` as a Marko tag runs client code and requires a runtime; this strict policy has no reactive target",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is client-only and requires a runtime; this strict policy has no reactive target",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for the reactive runtime; this strict policy has no reactive target",
  },
};

/**
 * The `strict` policy: stock Marko syntax, reactive constructs rejected by
 * name instead of rendered as inert or as their initial value.
 */
export const strictPolicy: Policy = {
  ...policy,
  tags: STRICT_TAGS,
};

/**
 * The one helper beyond `escape` the emitted module may need, inlined rather
 * than imported so the runtime surface stays a single import.
 *
 * A dynamic tag's target is whatever the expression evaluated to: a component
 * function, a renderable block (`() => string`), or a tag name as a string.
 */
const CLASS_VALUE = `function classValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return escape(value);
  if (Array.isArray(value)) {
    return value.map(classValue).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return Object.keys(value).filter(key => value[key]).map(escape).join(" ");
  }
  return escape(value);
}`;

const STYLE_VALUE = `function styleValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return escape(value);
  if (Array.isArray(value)) {
    return value.map(styleValue).filter(Boolean).join(";");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => v !== false && v !== null && v !== undefined && v !== "")
      .map(([key, v]) => escape(key) + ":" + escape(v))
      .join(";");
  }
  return escape(value);
}`;

const ESCAPE_COMMENT = `function escapeComment(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/>/g, "&gt;");
}`;

const RENDER_DYNAMIC = `function renderDynamic(target, props) {
  if (target === null || target === undefined) return "";
  if (typeof target === "string") {
    let out = "<" + target;
    for (const [key, value] of Object.entries(props)) {
      if (key === "content") continue;
      if (value === false || value === null || value === undefined) continue;
      out += value === true ? " " + key : " " + key + "=\\"" + escape(value) + "\\"";
    }
    out += ">";
    if (props.content) out += props.content();
    return out + "</" + target + ">";
  }
  return target(props);
}`;

/**
 * This host's post-emit pass: appends the helpers the module actually calls.
 *
 * Runs over the core's emitted module text (`HostOptions.postEmit`) rather
 * than inside the core's emitter, because *which* helpers exist — and that
 * they are inlined rather than imported, to keep the runtime surface at one
 * `escape` — is a property of this host's target, not of the core.
 */
export function emitProgram(code: string): string {
  // Each helper is emitted only when something calls it, so a template that
  // uses none of them compiles to `escape` and string concatenation alone —
  // which is the claim this package exists to make checkable.
  const helpers = [
    ["classValue(", CLASS_VALUE],
    ["styleValue(", STYLE_VALUE],
    ["escapeComment(", ESCAPE_COMMENT],
    ["renderDynamic(", RENDER_DYNAMIC],
  ]
    .filter(([call]) => code.includes(call as string))
    .map(([, source]) => source);

  if (helpers.length === 0) return code;

  // Placed after the author's own hoisted module scope so it cannot shadow a
  // binding they declared.
  return code.replace(
    "\nexport default function (input: Input): string {",
    `\n${helpers.join("\n\n")}\n\nexport default function (input: Input): string {`,
  );
}
