/**
 * `@markox/html` as a Marko translator (ADR 0001).
 *
 * `@marko/compiler` owns parsing, validation and the tag registry; this file
 * owns the one thing Marko cannot supply — MX's lowering rules for the string
 * target. The translator exports only `translate` (plus its own `taglibs`), so
 * the compiler injects no runtime: the emitted module's entire runtime surface
 * is the `escape` import.
 *
 * Two shapes of Marko's AST drive nearly everything here, both measured against
 * 5.42.5 rather than assumed:
 *
 * - Whitespace is already decision 33. Marko's own `onText` drops a
 *   whitespace-only run containing a newline and collapses a newline-free run
 *   to one space, so `MarkoText.value` arrives normalized and this file does
 *   not re-normalize it.
 * - Statement tags (`import`, `static`, `export`) parse as *tags* whose
 *   attributes are word soup, and their `start`/`end` are undefined. Their
 *   `loc` line/column, however, spans exactly the statement, so the source text
 *   is sliced back out by `loc` and re-parsed.
 */

import { parseBabel } from "@markox/parser";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiler calls the same helper the emitted module imports, so a static value and a runtime one are escaped by one implementation
import { escape } from "./escape.ts";

/** Raised for a construct that parses as Marko but has no string lowering. */
export class TranslateError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "TranslateError";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

const INDENT = "  ";

/**
 * A well-formed HTML attribute name, as source text for the emitted module.
 *
 * Validates spread keys, which are only known at run time. Anything containing
 * a space, quote, `/` or `>` could end the attribute name and start live markup
 * inside the tag, so it is skipped rather than emitted (decisions 42/44).
 */
const ATTR_NAME_PATTERN = "/^[A-Za-z_:][-A-Za-z0-9_:.]*$/";

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
 * Constructs that parse as Marko but need a reactive runtime, each rejected by
 * name (decision 54, brief's rejection table). A one-shot string render has
 * nowhere to put them, and accepting-then-dropping would read as support.
 */
const UNSUPPORTED_TAGS: Record<string, string> = {
  let: "`<let>` is reactive state and requires a runtime; standalone MX renders once to a string",
  effect:
    "`<effect>` is a reactive effect and requires a runtime; standalone MX renders once to a string",
  script:
    "`<script>` as a Marko tag runs client code and requires a runtime; standalone MX renders once to a string",
  lifecycle:
    "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; standalone MX renders once to a string",
  await:
    "`<await>` suspends on a promise and requires a runtime; standalone MX renders once to a string",
  try: "`<try>` is an error boundary and requires a runtime; standalone MX renders once to a string",
  client:
    "`<client>` marks client-only output and requires a runtime; standalone MX renders once to a string",
  server:
    "`<server>` is a server block and requires a runtime; standalone MX renders once to a string",
  id: "`<id>` requires a runtime; standalone MX renders once to a string",
};

interface Ctx {
  source: string;
  lines: string[];
  body: string[];
  hoisted: string[];
  inputInterface: string | null;
  /** `<define>`s bound so far, name -> declared parameter names in order. */
  defines: Map<string, string[]>;
  /** Local bindings introduced by the template's `import` statements. */
  imports: Set<string>;
  indent: number;
  generate: (node: Node) => string;
}

function fail(message: string, node: Node): never {
  const loc = node?.loc?.start ?? node?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, loc.line ?? 0, loc.column ?? 0);
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function push(ctx: Ctx, line: string): void {
  ctx.body.push(INDENT.repeat(ctx.indent) + line);
}

/**
 * Appends a run of literal HTML, merging into the preceding `out +=`.
 *
 * An element's tag, attributes and text would otherwise each take a line.
 */
function emitLiteral(ctx: Ctx, text: string): void {
  if (text === "") return;
  const last = ctx.body[ctx.body.length - 1];
  const prefix = INDENT.repeat(ctx.indent);
  if (last?.startsWith(`${prefix}out += "`) && last.endsWith('";')) {
    const existing = JSON.parse(last.slice(prefix.length + 7, -1)) as string;
    ctx.body[ctx.body.length - 1] =
      `${prefix}out += ${quote(existing + text)};`;
    return;
  }
  push(ctx, `out += ${quote(text)};`);
}

function emitExpression(ctx: Ctx, expression: string, escaped: boolean): void {
  push(ctx, `out += ${escaped ? `escape(${expression})` : `(${expression})`};`);
}

/** The source text an expression node came from, printed back to code. */
function expr(ctx: Ctx, node: Node): string {
  return ctx.generate(node);
}

/**
 * The statement's own source text.
 *
 * `import`/`static`/`export` arrive as tags whose attributes are word soup and
 * whose `start`/`end` are undefined; only `loc` spans the statement, so the
 * text is recovered by line/column and handed back to a real JS parser.
 */
function sliceLoc(ctx: Ctx, loc: Node): string {
  const { start, end } = loc;
  if (start.line === end.line) {
    return (ctx.lines[start.line - 1] ?? "").slice(start.column, end.column);
  }
  const first = (ctx.lines[start.line - 1] ?? "").slice(start.column);
  const middle = ctx.lines.slice(start.line, end.line - 1);
  const last = (ctx.lines[end.line - 1] ?? "").slice(0, end.column);
  return [first, ...middle, last].join("\n");
}

/**
 * The local binding names an `import` statement introduces — default,
 * namespace, and every named import, aliased or not.
 *
 * Parsed rather than regex-scraped: a tag name is only a component call when it
 * names one of these bindings, so an incomplete extraction here silently
 * misroutes exactly the tags this rule exists to route (decision 47).
 */
function importBindings(line: string): string[] {
  try {
    const file = parseBabel(line, { sourceType: "module" });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return [];
    return declaration.specifiers.map((s: Node) => s.local.name);
  } catch {
    return [];
  }
}

/** True when a child list holds anything that renders. */
function hasContent(children: Node[]): boolean {
  return children.some((child: Node) => {
    if (child.type === "MarkoComment") return false;
    if (child.type === "MarkoText") return child.value.trim() !== "";
    return true;
  });
}

/**
 * Renders a child list as a self-contained `() => string` function.
 *
 * Used for attribute-tag blocks and component children. The body gets its own
 * `out` local, so a block never appends to the enclosing template's buffer and
 * can be called zero or many times by the component that receives it.
 */
function blockFunction(ctx: Ctx, children: Node[], params = ""): string {
  const outer = ctx.body;
  const outerIndent = ctx.indent;
  ctx.body = [];
  ctx.indent = outerIndent + 1;
  push(ctx, 'let out = "";');
  emitChildren(ctx, children);
  push(ctx, "return out;");
  const lines = ctx.body;
  ctx.body = outer;
  ctx.indent = outerIndent;
  return `(${params}) => {\n${lines.join("\n")}\n${INDENT.repeat(outerIndent)}}`;
}

function attrByName(node: Node, name: string): Node | undefined {
  return (node.attributes ?? []).find(
    (a: Node) => a.type === "MarkoAttribute" && a.name === name,
  );
}

/**
 * Emits an element's attribute list into the open tag.
 *
 * Static values are baked into the literal and escaped at compile time, so the
 * emitted double-quoted style is independent of the author's quoting — a
 * single-quoted `title='a" onerror="…'` cannot close the attribute early
 * (decision 42). A spread emits a runtime loop that validates each key.
 */
function emitAttrs(ctx: Ctx, node: Node): void {
  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      const value = expr(ctx, attr.value);
      push(ctx, `for (const [key, value] of Object.entries(${value})) {`);
      ctx.indent++;
      push(
        ctx,
        "if (value === false || value === null || value === undefined) continue;",
      );
      push(ctx, `if (!${ATTR_NAME_PATTERN}.test(key)) continue;`);
      push(
        ctx,
        'out += value === true ? " " + key : " " + key + "=\\"" + escape(value) + "\\"";',
      );
      ctx.indent--;
      push(ctx, "}");
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

    const value = attr.value;
    // A bare attribute (`download`, `checked`) is HTML's spelling of `true`.
    if (value?.type === "BooleanLiteral" && value.value === true) {
      emitLiteral(ctx, ` ${attr.name}`);
      continue;
    }
    if (value?.type === "StringLiteral") {
      emitLiteral(ctx, ` ${attr.name}="${escape(value.value)}"`);
      continue;
    }
    emitLiteral(ctx, ` ${attr.name}="`);
    emitExpression(ctx, expr(ctx, value), true);
    emitLiteral(ctx, '"');
  }
}

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

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/**
 * All five `<for>` forms, each lowered to the plain JS loop that matches it.
 *
 * `by=` and `step=` are rejected by name rather than read and dropped
 * (decision 10 / S8): a one-shot string render has no reconciler to key
 * against, so accepting them would read as support from the outside.
 */
function emitFor(ctx: Ctx, node: Node): void {
  if (attrByName(node, "by")) {
    fail(
      "by= is not supported in a standalone template: string output has no reconciliation to key; remove by=",
      node,
    );
  }
  if (attrByName(node, "step")) {
    fail("`<for step=...>`: step is not supported; use a computed array", node);
  }

  const params: string[] = (node.body?.params ?? []).map((p: Node) =>
    expr(ctx, p),
  );
  const [first = "item", second] = params;
  const children = node.body?.body ?? [];

  const of = attrByName(node, "of");
  if (of) {
    const list = expr(ctx, of.value);
    if (second) {
      push(ctx, `for (const [${second}, ${first}] of ${list}.entries()) {`);
    } else {
      push(ctx, `for (const ${first} of ${list}) {`);
    }
    ctx.indent++;
    emitChildren(ctx, children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  const inAttr = attrByName(node, "in");
  if (inAttr) {
    const object = expr(ctx, inAttr.value);
    push(
      ctx,
      `for (const [${first}, ${second ?? "value"}] of Object.entries(${object})) {`,
    );
    ctx.indent++;
    emitChildren(ctx, children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  const to = attrByName(node, "to");
  const until = attrByName(node, "until");
  if (to || until) {
    const from = attrByName(node, "from");
    const start = from ? expr(ctx, from.value) : "0";
    const bound = expr(ctx, (to ?? until).value);
    const compare = to ? "<=" : "<";
    push(
      ctx,
      `for (let ${first} = ${start}; ${first} ${compare} ${bound}; ${first}++) {`,
    );
    ctx.indent++;
    emitChildren(ctx, children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
}

/** `<const/name=expr/>` -> a `const` at render scope. */
function emitConst(ctx: Ctx, node: Node): void {
  if (!node.var) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  if (!value?.value) fail("`<const>` without a value", node);
  push(ctx, `const ${expr(ctx, node.var)} = ${expr(ctx, value.value)};`);
}

/** `<define/name|params|>...</define>` -> a local `(params) => string`. */
function emitDefine(ctx: Ctx, node: Node): void {
  if (!node.var) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  const name = expr(ctx, node.var);
  const paramNames: string[] = (node.body?.params ?? []).map((p: Node) =>
    expr(ctx, p),
  );
  const fn = blockFunction(ctx, node.body?.body ?? [], paramNames.join(", "));
  ctx.defines.set(name, paramNames);
  push(ctx, `const ${name} = ${fn};`);
}

/**
 * `<if>` plus any `<else if>`/`<else>` siblings.
 *
 * Returns the index of the first sibling it did not consume, so the caller
 * resumes after the whole chain rather than re-reading `<else>` as a standalone
 * tag.
 */
function emitIfChain(ctx: Ctx, children: Node[], index: number): number {
  const node = children[index];
  const cond = attrByName(node, "value") ?? node.attributes?.[0];
  if (!cond?.value) fail("`<if>` without a condition", node);

  push(ctx, `if (${expr(ctx, cond.value)}) {`);
  ctx.indent++;
  emitChildren(ctx, node.body?.body ?? []);
  ctx.indent--;

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
    if (child.type !== "MarkoTag" || child.name?.value !== "else") break;

    const ifAttr = attrByName(child, "if");
    if (ifAttr) {
      push(ctx, `} else if (${expr(ctx, ifAttr.value)}) {`);
    } else {
      push(ctx, "} else {");
    }
    ctx.indent++;
    emitChildren(ctx, child.body?.body ?? []);
    ctx.indent--;
    i++;
    if (!ifAttr) break;
  }

  push(ctx, "}");
  return i;
}

/**
 * Statement tags, recovered from source and hoisted to module scope.
 *
 * `import` reaches module scope verbatim; `static` drops its keyword and joins
 * it there, running once per module rather than once per render; `export
 * interface Input` is lifted out so the emitted module can place it above the
 * render function it types.
 */
function emitStatement(ctx: Ctx, node: Node, name: string): void {
  const line = sliceLoc(ctx, node.loc).trim();

  if (name === "import") {
    ctx.hoisted.push(line);
    for (const binding of importBindings(line)) ctx.imports.add(binding);
    return;
  }
  if (name === "static") {
    ctx.hoisted.push(line.replace(/^static\s+/, ""));
    return;
  }
  if (/^export\s+interface\s+Input\b/.test(line)) {
    ctx.inputInterface = line;
    return;
  }
  fail(
    "a standalone template may only `export interface Input`; the module's default export is its render function",
    node,
  );
}

function emitTag(ctx: Ctx, node: Node): void {
  // A bare `${expr}` on its own line parses as a tag whose *name* is the
  // expression, with no attributes and no body — Marko's concise mode has no
  // other shape for it. Treated as the escaped placeholder the author wrote.
  if (node.name && node.name.type !== "StringLiteral") {
    if ((node.attributes ?? []).length === 0 && !node.body?.body?.length) {
      emitExpression(ctx, expr(ctx, node.name), true);
      return;
    }
    fail("dynamic tag name is not supported in a standalone template", node);
  }

  const name = String(node.name.value);

  const unsupported = UNSUPPORTED_TAGS[name];
  if (unsupported) fail(unsupported, node);

  switch (name) {
    case "import":
    case "static":
    case "export":
      emitStatement(ctx, node, name);
      return;
    case "for":
      emitFor(ctx, node);
      return;
    case "const":
      emitConst(ctx, node);
      return;
    case "define":
      emitDefine(ctx, node);
      return;
    case "fragment":
      emitChildren(ctx, node.body?.body ?? []);
      return;
    case "else":
      fail("`<else>` without a preceding `<if>`", node);
      return;
  }

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      node,
    );
  }

  // A tag matching an in-scope binding is a component call whatever its case
  // (decision 47); a `<define>` shadows a same-named import.
  if (ctx.defines.has(name) || ctx.imports.has(name)) {
    emitComponent(ctx, node, name);
    return;
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
  // the silent-failure mode ADR 0001 names: a core tag MX has no lowering for
  // must be an error, never a literal element. Hyphenated custom elements are
  // legal HTML and stay.
  if (!isHtmlElement(name)) {
    fail(
      `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }

  emitLiteral(ctx, `<${name}`);
  emitAttrs(ctx, node);
  emitLiteral(ctx, ">");

  if (VOID_TAGS.has(name)) return;

  emitChildren(ctx, node.body?.body ?? []);
  emitLiteral(ctx, `</${name}>`);
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

export function emitChildren(ctx: Ctx, children: Node[]): void {
  let index = 0;
  while (index < children.length) {
    const child = children[index];

    if (child.type === "MarkoTag" && child.name?.value === "if") {
      index = emitIfChain(ctx, children, index);
      continue;
    }

    switch (child.type) {
      case "MarkoText":
        // Already decision 33: Marko's own `onText` dropped newline-bearing
        // whitespace runs and collapsed the rest before we saw them.
        emitLiteral(ctx, child.value);
        break;
      case "MarkoPlaceholder":
        emitExpression(ctx, expr(ctx, child.value), child.escape);
        break;
      case "MarkoTag":
        emitTag(ctx, child);
        break;
      case "MarkoDocumentType":
        emitLiteral(ctx, `<!${child.value}>`);
        break;
      case "MarkoComment":
        // Marko strips the delimiters, so an HTML comment and a `//` line
        // comment are indistinguishable by value alone; the source decides.
        if (sliceLoc(ctx, child.loc).startsWith("<!--")) {
          emitLiteral(ctx, `<!--${child.value}-->`);
        }
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
}

/**
 * Builds the emitted TypeScript module for one parsed template.
 *
 * The module shape is fixed (S3): the escape import, the author's hoisted
 * module scope, their `Input` interface, and one default-exported render
 * function concatenating into a single local.
 */
export function emitProgram(
  body: Node[],
  source: string,
  generate: (node: Node) => string,
): string {
  const ctx: Ctx = {
    source,
    lines: source.split("\n"),
    body: [],
    hoisted: [],
    inputInterface: null,
    defines: new Map(),
    imports: new Set(),
    indent: 1,
    generate,
  };

  emitChildren(ctx, body);

  const lines: string[] = ['import { escape } from "@markox/html";'];
  if (ctx.hoisted.length > 0) lines.push("", ...ctx.hoisted);
  lines.push(
    "",
    ctx.inputInterface ?? "export interface Input {}",
    "",
    "export default function (input: Input): string {",
    `${INDENT}let out = "";`,
    ...ctx.body,
    `${INDENT}return out;`,
    "}",
    "",
  );
  return lines.join("\n");
}
