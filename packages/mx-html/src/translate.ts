/**
 * `@markox/html`'s dialect policy (ADR 0001).
 *
 * `@marko/compiler` owns parsing, validation and the tag registry; `core.ts`
 * owns everything that is a property of the string target itself. This file
 * owns the one remaining thing: the rules that are specific to MX's `.mx`
 * dialect, as distinct from stock Marko (which `@markox/translator` lowers
 * under a different policy over the same core).
 *
 * What is MX-specific here, and why:
 *
 * - **Attribute tags become callable function props** (S3). A component is a
 *   plain import called as a function returning `string`, so `<@header>`
 *   arrives as `header: () => string`. Stock Marko instead passes
 *   *renderables*; the two conventions are incompatible and each is correct
 *   for its own dialect.
 * - **Components are explicit imports or `<define>`s** — no `tags/`
 *   directory discovery. MX's convention, recorded in decision 65 as a
 *   convention rather than a rule the target imposes.
 * - **An element is one of a hand-carried set**, so an unknown lowercase tag
 *   is an error rather than literal markup.
 * - **Reactive constructs are rejected by name** (decision 54): `.mx` has no
 *   reactive target at all, so `<let>` here is an error, where stock Marko's
 *   `<let>` evaluates its initial value.
 */

import {
  blockFunction,
  type Ctx,
  type Disposition,
  emitChildren,
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
  VOID_TAGS,
} from "./core.ts";

export { TranslateError } from "./core.ts";

/**
 * Constructs that parse as Marko but need a reactive runtime, each rejected by
 * name (decision 54). A one-shot string render has nowhere to put them, and
 * accepting-then-dropping would read as support.
 *
 * Every entry is an `error`, not an `inert`: unlike stock Marko — where
 * `<let>` has an initial value a server render evaluates and `<effect>` is
 * genuinely inert — `.mx` declares no reactive dialect at all, so naming the
 * construct is more useful to an MX author than silently accepting it.
 */
const UNSUPPORTED_TAGS: Record<string, Disposition> = Object.fromEntries(
  (
    [
      [
        "let",
        "`<let>` is reactive state and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "effect",
        "`<effect>` is a reactive effect and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "script",
        "`<script>` as a Marko tag runs client code and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "lifecycle",
        "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "await",
        "`<await>` suspends on a promise and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "try",
        "`<try>` is an error boundary and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "client",
        "`<client>` marks client-only output and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "server",
        "`<server>` is a server block and requires a runtime; standalone MX renders once to a string",
      ],
      [
        "id",
        "`<id>` requires a runtime; standalone MX renders once to a string",
      ],
    ] as const
  ).map(([name, reason]) => [name, { kind: "error", reason } as Disposition]),
);

/**
 * Emits a component or `<define>` tag call.
 *
 * A real component receives one props object. Attribute tags (`<@header>`)
 * become named function props, and remaining children become `children` under
 * the same rule, so the component decides where to place each block.
 *
 * A `<define>` was lowered to a plain positional function, so a tag-call site
 * passes its arguments positionally in the declared order — otherwise every
 * named prop after the first binds to `undefined`.
 */
function emitComponent(ctx: Ctx, node: Node, name: string): void {
  // A component call is the one path that genuinely lowers attribute tags:
  // they become named function props. Tag arguments, a tag variable and type
  // arguments it does not lower, so they are rejected rather than dropped.
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, { attributeTags: true });

  const props = new Map<string, string>();
  const spreads: string[] = [];

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      spreads.push(expr(ctx, attr.value));
      continue;
    }
    if (attr.arguments) {
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
        attr,
      );
    }
    if (attr.bound) {
      fail(
        "`:=` is a two-way binding and requires a reactive runtime; standalone MX renders once to a string",
        attr,
      );
    }
    if (attr.modifier) {
      fail(
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
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

  for (const block of node.attributeTags ?? []) {
    if (block.type !== "MarkoTag") continue;
    const blockName = String(block.name.value).replace(/^@/, "");
    const params = (block.body?.params ?? [])
      .map((p: Node) => expr(ctx, p))
      .join(", ");
    props.set(blockName, blockFunction(ctx, block.body?.body ?? [], params));
  }

  const children = node.body?.body ?? [];
  if (hasContent(children)) {
    props.set("children", blockFunction(ctx, children));
  }

  const defineParams = ctx.defines.get(name);
  if (defineParams) {
    if (spreads.length > 0) {
      fail(
        `spreading into \`<${name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
        node,
      );
    }
    const args = defineParams.map((param) => props.get(param) ?? "undefined");
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
 * Whether a lowercase tag name is a real HTML/SVG element.
 *
 * A hyphen makes it a custom element, which is always legal. The explicit set
 * is what turns a typo or an unsupported Marko core tag into an error instead
 * of silently valid markup.
 */
function isHtmlElement(name: string): boolean {
  return name.includes("-") || HTML_ELEMENTS.has(name);
}

const HTML_ELEMENTS = new Set([
  ...VOID_TAGS,
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "map",
  "mark",
  "menu",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "select",
  "slot",
  "small",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "u",
  "ul",
  "var",
  "video",
  // SVG
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
  "defs",
  "use",
  "symbol",
  "marker",
  "mask",
  "pattern",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "foreignObject",
]);

/**
 * `<fragment>` is MX-only syntax: an explicit multi-root wrapper that renders
 * nothing of its own. Marko has no such tag (a template body may already have
 * several roots), so it lives in this policy rather than the shared core.
 */
function emitSpecial(ctx: Ctx, node: Node, name: string): boolean {
  if (name !== "fragment") return false;
  rejectUnsupportedFields(ctx, node, "`<fragment>`");
  if ((node.attributes ?? []).length > 0) {
    fail(
      "`<fragment>` takes no attributes: it renders nothing of its own, only its children",
      node,
    );
  }
  emitChildren(ctx, node.body?.body ?? []);
  return true;
}

/**
 * Rejects a render-scope binding that would shadow the `input` parameter.
 *
 * The emitted module is `function (input: Input)`, so `<const/input=1/>`
 * lowers to `const input = 1` inside it and every later `${input.x}` reads the
 * local instead — the template's own input becomes unreachable with no
 * diagnostic. The same rule as `@markox/translator`'s, and the same one Marko
 * enforces ("Duplicate declaration of `input`"), applied here because the
 * emitted module shape is identical.
 *
 * Tag params are deliberately not checked: `<for|input|>` opens a nested scope
 * where an ordinary JS shadow is correct.
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

export const policy: Policy = {
  tags: UNSUPPORTED_TAGS,
  isElement: isHtmlElement,
  emitComponent,
  // A tag matching an in-scope binding is a component call whatever its case
  // (decision 47); a `<define>` shadows a same-named import.
  isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  checkBinding: rejectInputShadowing,
  escapeFrom: "@markox/html",
  emitSpecial,
  keepComments: true,
};

export function emitProgram(
  body: Node[],
  source: string,
  generate: (node: Node) => string,
): string {
  return emitProgramCore(body, source, generate, policy);
}

// Re-exported so the fixture harness and tests keep their existing imports.
export { emitChildren, emitLiteral };
