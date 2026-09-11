/**
 * The MX → Astro-template emitter (decision 76c).
 *
 * An `.astro.mx` file is an Astro component whose *template* is MX instead of
 * Astro's own JSX-shaped markup:
 *
 * ```
 * ---
 * interface Props { title: string }
 * const { title } = Astro.props;
 * ---
 * <h1>${title}</h1>
 * <for|item, i| of=items>
 *   <li>${i}: ${item}</li>
 * </for>
 * ```
 *
 * The TypeScript fence is Astro's, untouched (`Astro.props`, imports,
 * `getStaticPaths`). Everything after it is MX, lowered here to Astro template
 * syntax and handed to Astro's own compiler as a `.astro` module.
 *
 * ## Why this is an emitter and not a `Policy`
 *
 * `@mxlang/core`'s `Policy` cannot express this target. The core's emit layer
 * is the **string-emit model**: `emitLiteral` pushes `out += "..."` statements,
 * `emitFor` pushes `for (const x of xs) {`, and `emitChildren` claims `<if>`
 * before any policy dispatch (`if (child.name?.value === "if") { emitIfChain }`).
 * Those are *statement*-shaped JS. Astro's template syntax is *expression*-
 * shaped — `{cond ? (…) : (…)}`, `{xs.map((x, i) => (…))}` — so no arrangement
 * of policy members produces it.
 *
 * `packages/core/README.md` states the rule this follows: "That model is not
 * hidden behind the policy, deliberately... A JSX host (SolidMX, phase 4)
 * replaces the emit layer instead." Astro's template syntax is JSX-shaped, so
 * `.astro.mx` is a JSX host by that rule. (The README's "Astro next" means the
 * existing `.mx`-to-string component host, which is unaffected by this file.)
 *
 * So this module uses the core's *other* front door — `parseFragment`, which
 * returns Marko's AST with every position shifted into the enclosing file,
 * which is exactly the base-offset machinery a template sitting after a fence
 * needs — and supplies its own emit layer over those nodes.
 *
 * The walk is deliberately split into a generic node walk and the emit
 * callbacks, so SolidMX's phase-4 JSX host can lift the walk rather than write
 * a third one. It is not generalised further than that: there is one consumer
 * today.
 */

import { parseFragment } from "@mxlang/core";

/** A Marko/Babel AST node, as loosely as this emitter needs it. */
// biome-ignore lint/suspicious/noExplicitAny: Marko's nodes are untyped here, as in @mxlang/core
type Node = any;

/**
 * A lowering failure, carrying the position in the **enclosing** `.astro.mx`
 * file.
 *
 * Mirrors `@mxlang/core`'s `TranslateError` shape (1-based `line`, 0-based
 * `column`) rather than reusing it, so a caller can tell an Astro-template
 * lowering error from a core one without unwrapping. `parseFragment` has
 * already shifted the positions past the fence, so no arithmetic happens here.
 */
export class AstroTemplateError extends Error {
  line: number;
  column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AstroTemplateError";
    this.line = line;
    this.column = column;
  }
}

function fail(message: string, node: Node): never {
  const loc = node?.loc?.start ?? { line: 0, column: 0 };
  throw new AstroTemplateError(message, loc.line ?? 0, loc.column ?? 0);
}

/**
 * HTML elements that never take a closing tag.
 *
 * Astro's compiler accepts both `<br>` and `<br />`, but emitting the
 * self-closed form uniformly keeps the output valid for every element and
 * avoids depending on which spelling Astro's parser is lenient about.
 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Structural tags the core owns, which this emitter lowers itself, plus the
 * tags that are errors on this host.
 *
 * `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` and `<id>` are
 * errors here for the same reason `@mxlang/astro`'s component host uses
 * `strictPolicy` (decision 71): this host renders static markup at build time
 * and ships no client JS, so a construct that only means something with a
 * reactive runtime is a build error naming the construct, never markup that
 * silently renders once and never updates.
 */
const STATEFUL_TAGS: Record<string, string> = {
  let: "`<let>` is reactive state and requires a runtime; `.astro.mx` renders static markup at build time",
  effect:
    "`<effect>` is a reactive effect and requires a runtime; `.astro.mx` renders static markup at build time",
  lifecycle:
    "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; `.astro.mx` renders static markup at build time",
  script:
    "`<script>` as a Marko tag runs client code and requires a runtime; `.astro.mx` renders static markup at build time",
  client:
    "a `client` block is client-only and requires a runtime; `.astro.mx` renders static markup at build time",
  id: "`<id>` allocates an identifier for the reactive runtime; `.astro.mx` renders static markup at build time",
  await:
    "`<await>` needs a suspense-capable renderer; `.astro.mx` renders static markup at build time",
  return:
    "`<return>` hands a value to a parent template; an Astro component has no parent template to return to",
};

/** Escapes text appearing as literal template content. */
function escapeText(text: string): string {
  // `{` and `}` open an expression in Astro's template grammar, so literal
  // braces in author text must be escaped or they silently become code.
  return text.replace(/[{}]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Escapes a static attribute value for a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * A tag name is a component when it is PascalCase or bound by an `import` in
 * the fence.
 *
 * JSX's own rule, which Astro shares: a lowercase name is an element, a
 * capitalised one is a component. This host follows JSX rather than Marko's
 * binding-based dispatch (`@mxlang/translator`'s rule), because the emitted
 * template *is* JSX-shaped and Astro's compiler applies the JSX rule to it —
 * emitting `<card />` for an imported `card` would produce a literal `<card>`
 * element in the output, not a component call.
 */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

interface EmitOptions {
  /** Names bound by `import` in the fence, for a better error message. */
  imports?: Set<string>;
}

/**
 * The emit callbacks the walk drives.
 *
 * Split out from `walk` so a future JSX host (SolidMX phase 4) can reuse the
 * walk with its own emitter, per the core README's "replaces the emit layer"
 * rule. Deliberately minimal — one method per node shape the walk produces.
 */
interface Emit {
  text(value: string): void;
  expression(source: string, escaped: boolean): void;
  open(tag: string, attrs: string, selfClosing: boolean): void;
  close(tag: string): void;
  raw(chunk: string): void;
}

/** Collects emitted chunks into one template string. */
function collector(): Emit & { done(): string } {
  const out: string[] = [];
  return {
    text: (value) => out.push(escapeText(value)),
    expression: (source, escaped) =>
      // Astro escapes an interpolated expression by default; `$!{…}` (MX's
      // unescaped placeholder) needs `set:html` semantics, which at expression
      // position is Astro's `<Fragment set:html={…} />`.
      out.push(escaped ? `{${source}}` : `<Fragment set:html={${source}} />`),
    open: (tag, attrs, selfClosing) =>
      out.push(`<${tag}${attrs}${selfClosing ? " /" : ""}>`),
    close: (tag) => out.push(`</${tag}>`),
    raw: (chunk) => out.push(chunk),
    done: () => out.join(""),
  };
}

/**
 * Prints an expression node back to source text.
 *
 * The nodes come from Marko's own Babel instance, so they are printed by
 * slicing the original source rather than by running a second generator over
 * them — `parseFragment` has already shifted `loc.*.index` into the enclosing
 * file, so the slice is taken against the whole `.astro.mx` text.
 *
 * Slicing, not generating, is what keeps the author's own spelling (and hence
 * the column positions Astro's own source map will later compose with) intact.
 */
function sourceOf(source: string, node: Node): string {
  const start = node?.loc?.start?.index;
  const end = node?.loc?.end?.index;
  if (typeof start === "number" && typeof end === "number") {
    return source.slice(start, end);
  }
  fail("expression has no source position", node);
}

function attrByName(node: Node, name: string): Node | undefined {
  return (node.attributes ?? []).find(
    (a: Node) => a.type === "MarkoAttribute" && a.name === name,
  );
}

/** The tag params of `<for|a, b|>` / `<Comp|a|>`, as source text. */
function paramsOf(source: string, node: Node): string[] {
  return (node.body?.params ?? []).map((p: Node) => sourceOf(source, p));
}

/**
 * Lowers an MX template body to Astro template syntax.
 *
 * `source` is the **whole** `.astro.mx` file (fence included), because
 * `parseFragment` reports positions against it and `sourceOf` slices it.
 */
export function emitTemplate(
  source: string,
  body: Node[],
  options: EmitOptions = {},
): string {
  const emit = collector();
  emitChildren(source, body, emit, options);
  return emit.done();
}

function emitChildren(
  source: string,
  children: Node[],
  emit: Emit,
  options: EmitOptions,
): void {
  let index = 0;
  while (index < children.length) {
    const child = children[index];

    // `<if>` consumes its own `<else if>`/`<else>` siblings, so it drives the
    // cursor itself — the same shape as the core's `emitIfChain`.
    if (child.type === "MarkoTag" && child.name?.value === "if") {
      index = emitIfChain(source, children, index, emit, options);
      continue;
    }

    emitNode(source, child, emit, options);
    index++;
  }
}

function emitNode(
  source: string,
  node: Node,
  emit: Emit,
  options: EmitOptions,
): void {
  switch (node.type) {
    case "MarkoText":
      // Marko's own `onText` already applied decision 33 (a whitespace-only
      // run containing a newline is dropped, others collapse to one space)
      // before this emitter sees the node, so it is emitted verbatim. A second
      // normalisation here would collapse twice.
      emit.text(node.value);
      return;
    case "MarkoPlaceholder":
      emit.expression(sourceOf(source, node.value), node.escape !== false);
      return;
    case "MarkoDocumentType":
      emit.raw(`<!${node.value}>`);
      return;
    case "MarkoComment":
      // Astro's template comment syntax is HTML's, and Astro strips it from
      // the output like any other HTML comment in a component.
      emit.raw(`<!--${node.value}-->`);
      return;
    case "MarkoScriptlet":
      fail("scriptlets (`$ statement`) are not supported in MX", node);
      return;
    case "MarkoTag":
      emitTag(source, node, emit, options);
      return;
    default:
      return;
  }
}

function emitTag(
  source: string,
  node: Node,
  emit: Emit,
  options: EmitOptions,
): void {
  const name = String(node.name?.value ?? "");

  if (name === "") {
    fail(
      "a dynamic tag name (`<${expr}>`) is not supported in an `.astro.mx` template; Astro resolves component names statically",
      node,
    );
  }

  const stateful = STATEFUL_TAGS[name];
  if (stateful) fail(stateful, node);

  if (name === "for") {
    emitFor(source, node, emit, options);
    return;
  }
  if (name === "const") {
    emitConst(source, node, emit, options);
    return;
  }
  if (name === "else" || name === "else-if") {
    fail(`\`<${name}>\` must follow an \`<if>\``, node);
  }
  if (name === "define") {
    fail(
      "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.astro.mx` file and import it",
      node,
    );
  }
  if (name === "try") {
    fail(
      "`<try>` needs an error boundary; Astro renders components statically at build time and has no equivalent",
      node,
    );
  }

  emitElement(source, node, name, emit, options);
}

/**
 * `<if=cond>` plus any `<else if>`/`<else>` siblings, as a ternary chain.
 *
 * Statement-shaped JS (`if (…) {`) has no meaning inside an Astro template, so
 * the chain becomes one expression: `{cond ? (<>…</>) : cond2 ? (<>…</>) : (<>…</>)}`.
 * Each branch's children are wrapped in a fragment, since a branch may contain
 * several roots or none.
 *
 * Returns the index of the first sibling it did not consume, so the caller
 * resumes past the whole chain rather than re-reading `<else>` as a tag.
 */
function emitIfChain(
  source: string,
  children: Node[],
  index: number,
  emit: Emit,
  options: EmitOptions,
): number {
  const node = children[index];
  const cond = attrByName(node, "value") ?? node.attributes?.[0];
  if (!cond?.value) fail("`<if>` without a condition", node);

  const branches: string[] = [];
  branches.push(
    `${sourceOf(source, cond.value)} ? (${fragment(source, node.body?.body ?? [], options)})`,
  );

  let i = index + 1;
  let closed = false;
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

    // `<else if=cond>` spells the condition as an `if` attribute; Marko's own
    // `<else-if=cond>` spells it as the tag's first (value) attribute.
    const ifAttr =
      childName === "else-if"
        ? (attrByName(child, "value") ?? child.attributes?.[0])
        : attrByName(child, "if");
    const branch = fragment(source, child.body?.body ?? [], options);
    if (ifAttr) {
      branches.push(`${sourceOf(source, ifAttr.value)} ? (${branch})`);
      i++;
      continue;
    }
    branches.push(`(${branch})`);
    closed = true;
    i++;
    break;
  }

  // A chain with no `<else>` still needs a falsy arm: Astro renders `null` as
  // nothing, which is what "no else branch" means.
  if (!closed) branches.push("null");
  emit.raw(`{${branches.join(" : ")}}`);
  return i;
}

/**
 * All of `<for>`'s forms, each as the array expression that matches it.
 *
 * `of=` maps directly; `in=` maps `Object.entries`; the numeric
 * `from=`/`to=`/`until=` form builds a range with `Array.from`, since a
 * template expression cannot contain a `for` statement. `step=` is rejected
 * for the same reason the core rejects it.
 */
function emitFor(
  source: string,
  node: Node,
  emit: Emit,
  options: EmitOptions,
): void {
  if (attrByName(node, "step")) {
    fail("`<for step=...>`: step is not supported; use a computed array", node);
  }

  const params = paramsOf(source, node);
  if (params.length === 0) {
    fail("`<for>` needs tag params: `<for|item| of=…>`", node);
  }
  const [first, second] = params;
  const branch = fragment(source, node.body?.body ?? [], options);

  const of = attrByName(node, "of");
  if (of) {
    const list = sourceOf(source, of.value);
    const args = second ? `${first}, ${second}` : first;
    emit.raw(`{[...${list}].map((${args}) => (${branch}))}`);
    return;
  }

  const inAttr = attrByName(node, "in");
  if (inAttr) {
    const object = sourceOf(source, inAttr.value);
    const args = `[${first}, ${second ?? "value"}]`;
    emit.raw(`{Object.entries(${object}).map((${args}) => (${branch}))}`);
    return;
  }

  const to = attrByName(node, "to");
  const until = attrByName(node, "until");
  if (to || until) {
    const from = attrByName(node, "from");
    const start = from ? sourceOf(source, from.value) : "0";
    const bound = sourceOf(source, (to ?? until).value);
    // `to` is inclusive, `until` exclusive — the same rule the core applies
    // with `<=` versus `<`.
    const length = to
      ? `(${bound}) - (${start}) + 1`
      : `(${bound}) - (${start})`;
    emit.raw(
      `{Array.from({ length: Math.max(0, ${length}) }, (_, $i) => (${start}) + $i).map((${first}) => (${branch}))}`,
    );
    return;
  }

  fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
}

/**
 * `<const/name=expr/>` — rejected, with the fence as the fix.
 *
 * A template expression cannot introduce a binding, and hoisting the
 * declaration into the fence would move it out of any `<for>` or `<if>` it was
 * written inside, changing what it means. The fence is where an Astro
 * component declares values, so that is what the message says.
 */
function emitConst(
  _source: string,
  node: Node,
  _emit: Emit,
  _options: EmitOptions,
): void {
  fail(
    "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
    node,
  );
}

/** Wraps a run of children in an Astro fragment, for a ternary/map branch. */
function fragment(
  source: string,
  children: Node[],
  options: EmitOptions,
): string {
  const emit = collector();
  emitChildren(source, children, emit, options);
  return `<Fragment>${emit.done()}</Fragment>`;
}

/**
 * An element or component call, with its attributes and children.
 *
 * Attribute tags (`<@name>`) become Astro **named slots** when the tag is a
 * component: `<Comp><div slot="name">…</div></Comp>`, which the spike verified
 * Astro renders into the component's `<slot name="name" />`. On an element
 * there is no slot mechanism to target, so they are an error.
 */
function emitElement(
  source: string,
  node: Node,
  name: string,
  emit: Emit,
  options: EmitOptions,
): void {
  const component = isComponentName(name);
  const attributeTags: Node[] = node.attributeTags ?? [];

  if (attributeTags.length > 0 && !component) {
    fail(
      `attribute tags (\`<@${String(attributeTags[0]?.name?.value ?? "").replace(/^@/, "")}>\`) lower to Astro named slots, which only a component accepts; \`<${name}>\` is an HTML element`,
      attributeTags[0],
    );
  }

  if ((node.body?.params ?? []).length > 0) {
    fail(
      `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
      node,
    );
  }

  const attrs = emitAttrs(source, node, name);
  const children: Node[] = node.body?.body ?? [];
  const hasChildren = children.length > 0 || attributeTags.length > 0;

  if (!hasChildren && (VOID_TAGS.has(name) || component)) {
    emit.open(name, attrs, true);
    return;
  }

  if (VOID_TAGS.has(name)) {
    fail(`\`<${name}>\` is a void element and cannot have children`, node);
  }

  emit.open(name, attrs, false);
  emitChildren(source, children, emit, options);

  for (const tag of attributeTags) {
    const slot = String(tag.name?.value ?? "").replace(/^@/, "");
    if ((tag.body?.params ?? []).length > 0) {
      fail(
        `\`<@${slot}>\` declares tag params, which lower to a render prop; Astro slots carry markup, not functions`,
        tag,
      );
    }
    // A slot's content is wrapped in a `<Fragment slot=…>` so the attribute
    // tag's own children keep their shape (several roots, or none) without
    // inventing a wrapper element the author did not write.
    emit.raw(`<Fragment slot="${escapeAttr(slot)}">`);
    emitChildren(source, tag.body?.body ?? [], emit, options);
    emit.raw("</Fragment>");
  }

  emit.close(name);
}

/**
 * An element's attributes, as Astro template attribute syntax.
 *
 * Static values pass through as-is; a dynamic value becomes `attr={expr}`; a
 * spread becomes `{...obj}`. `class` with a structured value (an object of
 * toggles, or an array) becomes Astro's own `class:list`, which the spike
 * verified collapses `{ on: true, off: false }` to `class="on"`.
 */
function emitAttrs(source: string, node: Node, tagName: string): string {
  const out: string[] = [];

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      out.push(` {...${sourceOf(source, attr.value)}}`);
      continue;
    }

    // An attribute method (`onClick() { … }`) arrives as a `FunctionExpression`
    // value, **not** through `attr.arguments` — measured against
    // `@marko/compiler` 5.42.5, where `arguments` is `false` for this shape and
    // the method body is the attribute's value. Testing only `attr.arguments`
    // (the core's own check, which fires for other shapes) let this fall
    // through to `sourceOf`, which failed with "expression has no source
    // position" — a parser-internal message for what is really an unsupported
    // construct. Both are tested.
    if (attr.arguments || attr.value?.type === "FunctionExpression") {
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; \`.astro.mx\` renders static markup at build time`,
        attr,
      );
    }
    if (attr.bound) {
      fail(
        "`:=` is a two-way binding and requires a reactive runtime; `.astro.mx` renders static markup at build time",
        attr,
      );
    }
    if (attr.modifier) {
      // Astro has `class:list` natively, but Marko's own parser rejects
      // `class:active` before this emitter ever runs, so this can only be
      // reached by a modifier Marko does accept.
      fail(
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in an \`.astro.mx\` template`,
        attr,
      );
    }

    const value = attr.value;
    // A bare attribute (`disabled`, `checked`) is HTML's spelling of `true`.
    if (value?.type === "BooleanLiteral" && value.value === true) {
      out.push(` ${attr.name}`);
      continue;
    }
    if (value?.type === "StringLiteral") {
      out.push(` ${attr.name}="${escapeAttr(value.value)}"`);
      continue;
    }

    const expression = sourceOf(source, value);

    // `class={a: true}` / `class=["x", {y: true}]` are Marko's structured
    // class forms. Astro spells the same thing `class:list`, so the structured
    // value is handed to it rather than stringified — interpolating the raw
    // object would render `[object Object]`.
    if (
      attr.name === "class" &&
      (value?.type === "ObjectExpression" || value?.type === "ArrayExpression")
    ) {
      out.push(` class:list={${expression}}`);
      continue;
    }

    // `style` takes an object in both languages, and Astro renders it.
    out.push(` ${attr.name}={${expression}}`);
  }

  if (tagName === "input") {
    // Marko hoists `value` ahead of every other attribute on an `<input>`,
    // because a browser applies `type` first and some types reinterpret a
    // later `value`. The same hoist keeps this host's markup matching.
    const index = out.findIndex((a) => a.startsWith(" value="));
    if (index > 0) {
      const [value] = out.splice(index, 1);
      out.unshift(value as string);
    }
  }

  return out.join("");
}

export interface LowerResult {
  /** The full `.astro` source: the original fence, then the lowered template. */
  code: string;
}

/**
 * Splits an `.astro.mx` file into its fence and its MX template, and lowers
 * the template.
 *
 * The fence is copied through **byte for byte**, including its `---`
 * delimiters, so the frontmatter Astro compiles is exactly what the author
 * wrote — every line number inside it is already correct with no mapping at
 * all. The template that follows starts at the same offset in both files
 * whenever the lowering is length-preserving, and `parseFragment` gives every
 * node a position in the original file for the cases where it is not.
 */
export function lowerAstroMx(source: string, filename: string): LowerResult {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/);
  const fence = match ? match[0] : "";
  const template = match ? source.slice(fence.length) : source;

  // Everything before the template is the fence, so the template's own
  // positions shift by exactly its length: `parseFragment` then reports every
  // node against the real `.astro.mx` file rather than against the substring.
  const baseOffset = fence.length;
  const baseLine = fence ? fence.split("\n").length - 1 : 0;

  const { body } = parseFragment(template, {
    filename,
    baseOffset,
    baseLine,
    baseColumn: 0,
  });

  const imports = new Set<string>();
  const lowered = emitTemplate(source, body, { imports });

  return { code: `${fence}${lowered}` };
}
