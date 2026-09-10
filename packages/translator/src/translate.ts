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
  emitProgram as emitProgramCore,
  expr,
  fail,
  hasContent,
  type Node,
  type Policy,
  propKey,
  push,
  quote,
  rejectUnsupportedFields,
} from "@markox/html/core";

export { TranslateError } from "@markox/html/core";

/**
 * The policy table of decision 65, as implemented.
 *
 * Inert entries were each verified against Marko's own server render: with
 * and without the construct, the emitted HTML is byte-identical. Error
 * entries are the two things a *synchronous* string function cannot express.
 */
const TAGS: Record<string, Disposition> = {
  // ---- inert: configures post-render behaviour, emits nothing ----
  effect: {
    kind: "inert",
    reason:
      "`<effect>` runs after render, on the client; a server render emits nothing for it (verified against Marko's own html output)",
  },
  lifecycle: {
    kind: "inert",
    reason:
      "`<lifecycle>` is a client-side lifecycle hook; a server render emits nothing for it",
  },
  script: {
    kind: "inert",
    reason:
      "`<script>` as a Marko tag is client-only behaviour, not markup; use `<html-script>` for a literal script element",
  },
  id: {
    kind: "inert",
    reason:
      "`<id>` allocates a unique identifier for the reactive runtime; nothing is emitted for it here",
  },
  log: {
    kind: "inert",
    reason: "`<log>` writes to the console; it emits no markup",
  },
  debug: {
    kind: "inert",
    reason: "`<debug>` is a debugger hook; it emits no markup",
  },
  client: {
    kind: "inert",
    reason:
      "a `client` block is evaluated only on the client; a server render emits nothing for it",
  },

  // ---- error: this target genuinely cannot express it ----
  await: {
    kind: "error",
    reason:
      "`<await>` suspends on a promise; this target is a synchronous `(input) => string` and cannot await. Marko itself refuses to render one to a string (\"Cannot consume asynchronous render with 'toString'\")",
  },
};

/**
 * `<let>`, `<const>` and `<return>` bind a value; `server` blocks run.
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
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  // `<let/x/>` with no value is a declared-but-unset binding; Marko renders
  // `undefined` for it, and so does an initialiser-less `const` here.
  const init = value?.value ? expr(ctx, value.value) : "undefined";
  push(ctx, `const ${expr(ctx, node.var)} = ${init};`);
  return true;
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

  if (name === "html-comment") {
    rejectUnsupportedFields(ctx, node, "`<html-comment>`");
    const text = (node.body?.body ?? [])
      .filter((c: Node) => c.type === "MarkoText")
      .map((c: Node) => c.value)
      .join("");
    push(ctx, `out += ${quote(`<!--${text}-->`)};`);
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
  emitBoundAttr,
  orderAttrs,
  escapeFrom: "@markox/translator",
  emitSpecial,
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

export function emitProgram(
  body: Node[],
  source: string,
  generate: (node: Node) => string,
  lookup?: Ctx["lookup"],
): string {
  const code = emitProgramCore(body, source, generate, policy, lookup);

  // Each helper is emitted only when something calls it, so a template that
  // uses none of them compiles to `escape` and string concatenation alone —
  // which is the claim this package exists to make checkable.
  const helpers = [
    ["classValue(", CLASS_VALUE],
    ["styleValue(", STYLE_VALUE],
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
