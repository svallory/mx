/**
 * `@mxlang/translator`'s dialect policy: stock `.marko`, expressions-only.
 *
 * Decision 66. The lowering core is shared with `@mxlang/html`
 * (`@mxlang/html`'s `core.ts`); this file supplies only what differs, and
 * every difference is a property of *stock Marko's conventions* rather than a
 * preference:
 *
 * - **Attribute tags are renderables, not callable props.** Marko's own
 *   convention is that `<@header>` reaches the component as `input.header`,
 *   rendered with `<${input.header}/>`, and that a *repeated* attribute tag
 *   arrives as an array. Both verified against Marko 5.42.5's own server
 *   render, not assumed. `@mxlang/html` passes callable function props
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
  type Block,
  type Ctx,
  type Disposition,
  DYNAMIC_TAG,
  type Expr,
  expr,
  fail,
  hasContent,
  type Node,
  type Policy,
  rejectUnsupportedFields,
  resolveChildren,
  sliceLoc,
} from "@mxlang/core";

export { TranslateError } from "@mxlang/core";

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
export function escapeComment(text: string): string {
  return text.replace(/>/g, "&gt;");
}

/**
 * Whether a tag name is an element, per Marko's own registry.
 *
 * `marko-html`, `marko-svg` and `marko-math` are the taglibs Marko loads for
 * HTML, SVG and MathML elements; anything they define is an element. A
 * hyphenated name is only a *custom* element when Marko's own taglib lookup
 * actually resolves it — real Marko errors on an unresolved one ("Unable to
 * find entry point for custom tag `<my-widget>`", verified against
 * `@marko/compiler` 5.42.5 / `marko@6.3.51`; see fixture `unknown-element`),
 * it does not render it as literal HTML. Treating every hyphenated name as
 * automatically legal (the previous behaviour here) was strictly more
 * permissive than Marko, which is exactly the class of divergence decision
 * 67 closes.
 */
const ELEMENT_TAGLIBS = new Set(["marko-html", "marko-svg", "marko-math"]);

function isElement(name: string, ctx: Ctx): boolean {
  const taglibId = ctx.lookup?.getTag(name)?.taglibId;
  return taglibId !== undefined && ELEMENT_TAGLIBS.has(taglibId);
}

/**
 * Whether a tag name resolves to a component.
 *
 * An `import` binding or a `<define>` is one, as in `@mxlang/html`. So is a
 * tag Marko *discovered* — a `.marko` file in a `tags/` directory beside the
 * template — which is the convention this dialect exists to support and the
 * one MX's own dialect deliberately does not have.
 *
 * A *lowercase* local binding (`import layout from "./layout.marko"` then
 * `<layout>`) is not called directly: real Marko rejects it ("Local
 * variables must be in a dynamic tag unless they are PascalCase. Use
 * `<${layout}/>` or rename to `Layout`.", verified against `@marko/compiler`
 * 5.42.5 / `marko@6.3.51`; see fixture `lowercase-component`) because a
 * lowercase tag name is only ever resolved through taglib/`tags/`
 * discovery, never through a local variable — that ambiguity is what the
 * dynamic-tag syntax exists to remove. A taglib-discovered tag has no such
 * ambiguity (it is never a local variable), so it is unaffected by this
 * check regardless of case. `isComponent` only decides routing (it has no
 * `node` to report a location with); the rejection itself is raised in
 * `emitComponent`, the first place downstream that has one.
 */
function isComponent(name: string, ctx: Ctx): boolean {
  if (ctx.defines.has(name) || ctx.imports.has(name)) return true;
  const taglibId = ctx.lookup?.getTag(name)?.taglibId;
  if (taglibId === undefined) return false;
  return !ELEMENT_TAGLIBS.has(taglibId) && taglibId !== "mx-translator-core";
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
 * core falls back to `@mxlang/html`'s wording ("not supported in a standalone
 * template"), which is `.mx`'s vocabulary leaking into a Marko-parity target.
 */
function emitModifier(_ctx: Ctx, attr: Node): boolean {
  fail(
    `\`${attr.name}:${attr.modifier}\` is not a valid attribute; Marko rejects this form too — write \`${attr.name}={ ${attr.modifier}: condition }\``,
    attr,
  );
}

/**
 * The sentinel `claimsTag`/`resolveHostTag` see for `<${expr}/>`.
 *
 * Re-exported under this package's own name so the emitter matches the same
 * value the core passes, rather than retyping a sentinel — two hand-typed
 * copies is exactly the drift that makes one side silently stop matching.
 */
export const DYNAMIC = DYNAMIC_TAG;

/**
 * What `resolveHostTag` decides about a tag this host claims, for its emitter.
 *
 * Recorded while the Marko node is still in hand (decision 79's `data` slot),
 * so the emitter never re-inspects one to recover a decision the resolver
 * already made.
 */
export type HostTagData =
  /** `<let>`/`<const>`: bind the initial value at render scope. */
  | { kind: "binding"; init: string }
  /** A `server` block: hoists and runs, exactly as `static` does. */
  | { kind: "statement"; code: string }
  | { kind: "html-comment" }
  /** `<html-script>`/`<html-style>`: a literal element with a raw-text body. */
  | { kind: "raw-element"; tag: string }
  | { kind: "style" }
  | { kind: "try" }
  /** `<${expr}/>`: the target expression, and its children as `content`. */
  | { kind: "dynamic"; expr: Expr; content: Block | null };

/** Tag names this host lowers itself, rather than as a component or element. */
const CLAIMED = new Set([
  // `<const>` is deliberately absent: the core's own switch dispatches it to
  // `resolveConst` before `claimsTag` is ever consulted, so an entry here
  // would be dead code that reads as though this host owned the tag.
  "let",
  "server",
  "html-comment",
  "html-script",
  "html-style",
  "style",
  "try",
  DYNAMIC_TAG,
]);

function claimsTag(name: string): boolean {
  return CLAIMED.has(name);
}

/**
 * Resolves a claimed tag to the decision its emitter needs.
 *
 * Every rejection this host makes for its own tags happens here, during
 * resolve, so a construct the target cannot express fails with a position
 * rather than reaching an emitter that would have to re-derive why.
 */
function resolveHostTag(name: string, node: Node, ctx: Ctx): HostTagData {
  if (name === DYNAMIC_TAG) {
    const children = node.body?.body ?? [];
    return {
      kind: "dynamic",
      expr: { code: expr(ctx, node.name), node: node.name },
      content: hasContent(children)
        ? {
            params: [],
            children: resolveChildren(ctx, children),
            loc: {
              line: node.loc?.start?.line ?? 0,
              column: node.loc?.start?.column ?? 0,
            },
          }
        : null,
    };
  }

  if (name === "let" || name === "const") {
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
    // renders as the empty string.
    return {
      kind: "binding",
      init: value?.value ? expr(ctx, value.value) : "undefined",
    };
  }

  if (name === "server") {
    return {
      kind: "statement",
      code: sliceLoc(ctx, node.loc)
        .trim()
        .replace(/^server\s+/, ""),
    };
  }

  if (name === "html-comment") {
    rejectUnsupportedFields(ctx, node, "`<html-comment>`");
    return { kind: "html-comment" };
  }

  if (name === "html-script" || name === "html-style") {
    rejectUnsupportedFields(ctx, node, `\`<${name}>\``);
    return { kind: "raw-element", tag: name.slice("html-".length) };
  }

  if (name === "style") {
    rejectUnsupportedFields(ctx, node, "`<style>`");
    return { kind: "style" };
  }

  // `<try>` with a `<@placeholder>` needs a second render pass over suspended
  // content, which this target has no way to schedule.
  const placeholder = (node.attributeTags ?? []).find(
    (t: Node) => String(t.name?.value) === "@placeholder",
  );
  if (placeholder) {
    fail(
      "`<try>` with a `<@placeholder>` needs a second render pass over suspended content; a synchronous string render has nowhere to schedule it",
      placeholder,
    );
  }
  return { kind: "try" };
}

export const policy: Policy = {
  tags: TAGS,
  isElement,
  isComponent,
  checkBinding: rejectInputShadowing,
  escapeFrom: "@mxlang/translator",
  claimsTag,
  resolveHostTag,
  // The resolver offers the host first refusal on a modifier so the
  // diagnostic quotes Marko's own fix-it rather than the core's
  // "standalone template" wording, which is `.mx` dialect vocabulary leaking
  // into a Marko-parity target.
  rejectModifier: (attr: Node) => emitModifier(undefined as never, attr),
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
 * The core's emitted default export, as text, for the two rewrites below.
 *
 * Both `emitProgram`'s helper injection and `brandRender` key off this exact
 * line, so it is written once rather than twice.
 */
const DEFAULT_EXPORT = "\nexport default function (input: Input): string {";

/**
 * The brand a host's `check()` tests for.
 *
 * `Symbol.for`, not a unique symbol: the property is written by the compiled
 * module and read by a *different* package (`@mxlang/astro`'s renderer), quite
 * possibly from a different copy of this one on disk, so the two sides must
 * agree on the symbol by name through the global registry rather than by
 * identity through a shared import.
 */
export const MX_COMPONENT = Symbol.for("mx.component");

/**
 * Marks the compiled module's default export as an MX component.
 *
 * A framework host that receives a component as an opaque value — Astro's
 * renderer contract hands `check(Component, props, slots)` the function and
 * nothing else — has no other way to tell an MX template apart from any other
 * function. Astro's own docs suggest sniffing `Component.name`, which a
 * minifier is free to rewrite and which any function could collide with; an
 * explicit brand is exact.
 *
 * The core emits the default export anonymously, so the function is given a
 * name here, branded, and then exported: `export default function (input) {}`
 * has no binding to hang a property off.
 *
 * `Object.defineProperty` rather than `render[Symbol.for(…)] = true`: the
 * emitted module is TypeScript, and a consumer runs `tsc` over it. Assigning
 * through a computed symbol key is `TS7053` ("expression of type 'symbol'
 * can't be used to index type 'typeof render'") under `strict`, which would
 * make every compiled template a type error in the user's own build. The
 * defineProperty form needs no index signature, and leaves the brand
 * non-enumerable besides, so it never shows up in a spread of the function's
 * own properties.
 *
 * **Throws if the core's export line is not found.** Recognising the emitted
 * module by matching a literal is brittle by construction: if the core's
 * emitter ever changes that line, a silent `return code` would hand back an
 * unbranded module, and every `check()` in the Astro host would answer false
 * with nothing anywhere reporting why — a whole host quietly failing to claim
 * its own components. Decision 61: fail loud at the seam that broke.
 *
 * A plain `Error`, not a `TranslateError`: this runs over emitted text, not
 * over a Marko node, so there is no source line or column to carry and
 * inventing one would point the reader at innocent template code.
 *
 * The real fix is to stop matching text at all — load the emitted module and
 * brand the function object — which is the `oracle-shape` follow-up task,
 * where `packages/oracle/src/translator-render.ts` has the same brittleness.
 */
export function brandRender(code: string): string {
  if (!code.includes(DEFAULT_EXPORT)) {
    throw new Error(
      "@mxlang/translator: cannot brand the compiled module — the emitted " +
        `code does not contain the expected default export line ${JSON.stringify(
          DEFAULT_EXPORT.trimStart(),
        )}. The core's emitter has changed shape; update DEFAULT_EXPORT in ` +
        "translate.ts to match, or an Astro host's `check()` will silently " +
        "stop recognising MX components.",
    );
  }

  return `${code.replace(
    DEFAULT_EXPORT,
    "\nfunction render(input: Input): string {",
  )}
Object.defineProperty(render, Symbol.for("mx.component"), { value: true });

export default render;
`;
}

/**
 * This host's post-emit pass: appends the helpers the module actually calls,
 * and brands the default export.
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

  if (helpers.length === 0) return brandRender(code);

  // Placed after the author's own hoisted module scope so it cannot shadow a
  // binding they declared.
  return brandRender(
    code.replace(
      DEFAULT_EXPORT,
      `\n${helpers.join("\n\n")}\n${DEFAULT_EXPORT}`,
    ),
  );
}
