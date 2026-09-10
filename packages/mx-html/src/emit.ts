import type {
  MxAttr,
  MxChild,
  MxElement,
  MxRange,
  MxStatement,
  MxTemplate,
} from "@markox/parser";
import { isVoidTag, normalizeText, parseBabel } from "@markox/parser";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiler calls the same helper the emitted module imports, so a static value and a runtime one are escaped by one implementation
import { escape } from "./escape.ts";

/**
 * The string-emitting lowering target: an `MxTemplate` in, TypeScript source
 * text out.
 *
 * This is deliberately a *text* emitter rather than a Babel-AST one. The
 * SolidMX target builds JSX nodes because its output is fed to another
 * compiler; here the emitted module is the final artifact, read by humans in
 * stack traces and diffed by the golden suite. Building an AST only to print it
 * would cost a dependency and buy nothing — and the goldens are the reason the
 * output is written as readable `out += ...` concatenation rather than an array
 * join.
 */

/** Raised for a construct that parses but cannot be emitted to a string. */
export class EmitError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = "EmitError";
  }
}

interface EmitContext {
  source: string;
  /** Lines of the render function body, already indented. */
  body: string[];
  /** Module-scope lines: the author's imports and `static` blocks. */
  hoisted: string[];
  /** The author's `export interface Input`, verbatim, or null. */
  inputInterface: string | null;
  /**
   * `<define/name|params|>`s bound so far, keyed by name, value is the
   * declared parameter names in order. A tag-call site (`<name .../>`) needs
   * this order to pass its props positionally, matching the function it
   * declares; the props-object call `emitComponent` otherwise always makes
   * is only correct for a real component's `props` parameter.
   */
  defines: Map<string, string[]>;
  /** Local bindings introduced by the template's `import` statements. */
  imports: Set<string>;
  indent: number;
}

const INDENT = "  ";

/**
 * A well-formed HTML attribute name, as source text for the emitted module.
 *
 * Used to validate the keys of a spread object, which are only known at run
 * time. Anything outside this shape — most importantly anything containing a
 * space, a quote, `/` or `>` — could end the attribute name and start live
 * markup inside the tag, so it is skipped rather than emitted.
 */
const ATTR_NAME_PATTERN = "/^[A-Za-z_:][-A-Za-z0-9_:.]*$/";

function fail(message: string, range: MxRange): never {
  throw new EmitError(message, range.start, range.end);
}

/** A JS double-quoted string literal for `text`. */
function quote(text: string): string {
  return JSON.stringify(text);
}

function push(ctx: EmitContext, line: string): void {
  ctx.body.push(INDENT.repeat(ctx.indent) + line);
}

/**
 * Appends a run of literal HTML.
 *
 * Consecutive literals are merged into the preceding `out +=` rather than
 * emitted as their own statement. An element's tag, its attributes and its
 * text would otherwise each take a line, and the goldens would be unreadable.
 */
function emitLiteral(ctx: EmitContext, text: string): void {
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

/** Appends an expression, escaped or raw. */
function emitExpression(
  ctx: EmitContext,
  expression: string,
  escaped: boolean,
): void {
  push(ctx, `out += ${escaped ? `escape(${expression})` : `(${expression})`};`);
}

function text(ctx: EmitContext, range: MxRange): string {
  return ctx.source.slice(range.start, range.end);
}

/**
 * The source text of an attribute that carries a value, quotes stripped.
 *
 * The returned text is **raw** — exactly what the author typed between the
 * quotes. For a static value that reaches HTML it must be escaped first; see
 * `staticAttrValue`. This function stays raw because two callers need the
 * unescaped form: the `class` shorthand merge (which escapes the joined
 * result once) and every expression-valued attribute, where the text is
 * TypeScript source rather than HTML.
 */
function attrValueText(
  ctx: EmitContext,
  attr: Extract<MxAttr, { kind: "static" | "dynamic" }>,
): string {
  if (attr.kind === "static") {
    // The recorded range keeps the author's quotes; the value is what is inside.
    return text(ctx, attr.value).slice(1, -1);
  }
  return text(ctx, attr.value);
}

/**
 * A static attribute value, escaped for the double-quoted context the emitter
 * always writes.
 *
 * MX takes the author's quote style from the source but emits one fixed style,
 * so the two can disagree: `title='a" onerror="alert(1)'` is a single-quoted
 * attribute that legally contains a raw `"`. Splicing that text into a
 * double-quoted literal closes the attribute early and turns the remainder
 * into live markup — an executing event handler from a value the author
 * believed was inert text.
 *
 * Escaping at compile time rather than trusting the source quoting is what
 * makes the emitted quote style independent of the written one. The value is
 * known statically, so this costs nothing at render time.
 *
 * The Solid target has no equivalent hole: it builds a Babel `StringLiteral`
 * and the printer re-quotes it, so the original quoting is preserved rather
 * than reinterpreted.
 */
function staticAttrValue(
  ctx: EmitContext,
  attr: Extract<MxAttr, { kind: "static" }>,
): string {
  return escape(attrValueText(ctx, attr));
}

/**
 * Emits an element's attribute list into the open tag.
 *
 * Static values are baked into the literal. Dynamic ones become an escaped
 * interpolation, and because `escape` covers both quote characters the emitted
 * attribute is always safely double-quoted.
 *
 * A boolean attribute emits its bare name, which is how HTML spells `true`.
 * A spread cannot be resolved at compile time, so it emits a runtime loop that
 * renders whatever keys the object turns out to have.
 */
function emitAttrs(ctx: EmitContext, el: MxElement): void {
  const shorthandClasses = el.shorthandClasses.map((r) =>
    text(ctx, r).slice(1),
  );
  const staticClass = el.attrs.find(
    (a): a is Extract<MxAttr, { kind: "static" }> =>
      a.kind === "static" && a.name === "class",
  );

  // Shorthand `.a.b` and a static `class="x"` are one attribute in the output,
  // shorthand first (decision D9/D30). Emitting both would put `class` on the
  // element twice, and a browser keeps only the first.
  if (shorthandClasses.length > 0) {
    const merged = [
      shorthandClasses.join(" "),
      staticClass ? attrValueText(ctx, staticClass) : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
    // Escaped for the same reason a plain static value is: the merged-in
    // `class="..."` half carries the author's own quoting, so a single-quoted
    // `class='x" onload="…'` would otherwise close the attribute here.
    emitLiteral(ctx, ` class="${escape(merged)}"`);
  }

  const shorthandId = el.shorthandIds[0];
  if (shorthandId) {
    // A shorthand `#id` comes from the tag name, where the tokenizer already
    // stops at a quote or space, so it cannot carry one — escaped anyway so
    // no attribute value reaches the output on an unescaped path.
    emitLiteral(ctx, ` id="${escape(text(ctx, shorthandId).slice(1))}"`);
  }

  for (const attr of el.attrs) {
    if (
      attr.kind === "static" &&
      attr.name === "class" &&
      shorthandClasses.length > 0
    ) {
      continue;
    }
    switch (attr.kind) {
      case "static":
        emitLiteral(ctx, ` ${attr.name}="${staticAttrValue(ctx, attr)}"`);
        break;

      case "dynamic": {
        emitLiteral(ctx, ` ${attr.name}="`);
        emitExpression(ctx, attrValueText(ctx, attr), true);
        emitLiteral(ctx, '"');
        break;
      }

      case "boolean":
        emitLiteral(ctx, ` ${attr.name}`);
        break;

      case "spread": {
        // Values: `false`/`null`/`undefined` drop out, matching how HTML
        // treats an absent attribute, and `true` renders the bare name like
        // any other boolean attribute.
        //
        // Keys are validated, not escaped. The object is user-controlled at
        // runtime, so a hostile key such as `x onload="alert(1)"` would
        // otherwise be concatenated straight into the tag and start a second,
        // live attribute. Escaping cannot fix that: a key containing a space
        // ends the attribute name whatever its other characters are encoded
        // as, so the only safe treatment is to reject anything that is not a
        // well-formed attribute name. The pattern is HTML's own name
        // production, and a key that fails it is skipped rather than thrown
        // on — one bad key in a spread should not take down a whole page
        // render.
        const value = text(ctx, attr.value);
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
        break;
      }

      case "method":
        fail(
          `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
          attr.nameRange,
        );
        break;

      case "bound":
        fail(
          "`:=` is a two-way binding and requires a reactive runtime; standalone MX renders once to a string",
          attr.nameRange,
        );
        break;
    }
  }
}

function attrByName(el: MxElement, name: string): MxAttr | undefined {
  return el.attrs.find((a) => "name" in a && a.name === name);
}

/** The `=value` shorthand attribute, which htmljs-parser reports with an empty name. */
function shorthandValue(el: MxElement): MxAttr | undefined {
  return attrByName(el, "");
}

function requireExpressionAttr(
  ctx: EmitContext,
  attr: MxAttr | undefined,
  what: string,
  at: MxRange,
): string {
  if (!attr || (attr.kind !== "dynamic" && attr.kind !== "static")) {
    fail(what, at);
  }
  return attrValueText(ctx, attr);
}

/**
 * Emits a component or `<define>` tag call.
 *
 * A real component receives one props object: `out += Name({ props })`.
 * Attribute tags (`<@header>...</@header>`) become named function props, so
 * the component receives `{ header: () => string }` and decides where to
 * place the block; remaining children become a `children` prop under the
 * same rule.
 *
 * A `<define>`, though, was lowered by `emitDefine` to a plain positional
 * function `(a, b) => ...`, not one that destructures a props object — the
 * function-call form (`card("x", "y")`) already calls it that way. A tag-call
 * site must therefore pass the same arguments positionally, in the order the
 * `<define>` declared them, or every named prop after the first binds to
 * `undefined` (this was the tag-call-form bug: fixed here rather than by
 * changing `emitDefine`, so the working function-call form is untouched).
 */
function emitComponent(ctx: EmitContext, el: MxElement): void {
  const name = el.staticName as string;
  const props = new Map<string, string>();
  const spreads: string[] = [];

  for (const attr of el.attrs) {
    switch (attr.kind) {
      case "static":
        props.set(attr.name, quote(attrValueText(ctx, attr)));
        break;
      case "dynamic":
        props.set(attr.name, attrValueText(ctx, attr));
        break;
      case "boolean":
        props.set(attr.name, "true");
        break;
      case "spread":
        spreads.push(text(ctx, attr.value));
        break;
      case "method":
        fail(
          `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
          attr.nameRange,
        );
        break;
      case "bound":
        fail(
          "`:=` is a two-way binding and requires a reactive runtime; standalone MX renders once to a string",
          attr.nameRange,
        );
        break;
    }
  }

  const named: MxElement[] = [];
  const rest: MxChild[] = [];
  for (const child of el.children) {
    if (child.kind === "element" && child.element.staticName?.startsWith("@")) {
      named.push(child.element);
    } else {
      rest.push(child);
    }
  }

  for (const block of named) {
    const blockName = (block.staticName as string).slice(1);
    props.set(blockName, blockFunction(ctx, block.children));
  }

  if (hasContent(ctx, rest)) {
    props.set("children", blockFunction(ctx, rest));
  }

  const defineParams = ctx.defines.get(name);
  if (defineParams) {
    if (spreads.length > 0) {
      fail(
        `spreading into \`<${name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
        el.name,
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

/** A property key, quoted only when it is not a plain identifier. */
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/** True when a child list holds anything that renders. */
function hasContent(ctx: EmitContext, children: MxChild[]): boolean {
  return children.some((child) => {
    if (child.kind === "comment") return false;
    if (child.kind === "text") return text(ctx, child.range).trim() !== "";
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
function blockFunction(ctx: EmitContext, children: MxChild[]): string {
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
  return `() => {\n${lines.join("\n")}\n${INDENT.repeat(outerIndent)}}`;
}

/**
 * `<if=cond>` plus any `<else if>`/`<else>` siblings.
 *
 * Returns the index of the first sibling it did not consume, so the caller's
 * loop resumes after the whole chain rather than re-reading the `<else>` as a
 * standalone tag.
 */
function emitIfChain(
  ctx: EmitContext,
  children: MxChild[],
  index: number,
): number {
  const el = (children[index] as { element: MxElement }).element;
  const cond = requireExpressionAttr(
    ctx,
    shorthandValue(el),
    "`<if>` without a condition",
    el.name,
  );

  push(ctx, `if (${cond}) {`);
  ctx.indent++;
  emitChildren(ctx, el.children);
  ctx.indent--;

  let i = index + 1;
  while (i < children.length) {
    const child = children[i] as MxChild;
    // Whitespace and comments between the branches are layout, not content.
    if (child.kind === "comment") {
      i++;
      continue;
    }
    if (child.kind === "text" && text(ctx, child.range).trim() === "") {
      i++;
      continue;
    }
    if (child.kind !== "element" || child.element.staticName !== "else") break;

    const branch = child.element;
    const ifAttr = attrByName(branch, "if");
    if (ifAttr) {
      const branchCond = requireExpressionAttr(
        ctx,
        ifAttr,
        "`<else if>` without a condition",
        branch.name,
      );
      push(ctx, `} else if (${branchCond}) {`);
    } else {
      push(ctx, "} else {");
    }
    ctx.indent++;
    emitChildren(ctx, branch.children);
    ctx.indent--;
    i++;
    if (!ifAttr) break;
  }

  push(ctx, "}");
  return i;
}

/**
 * All five `<for>` forms, each lowered to the plain JS loop that matches it.
 *
 * `of=` and `in=` iterate a collection; `from=`/`to=` and `from=`/`until=` are
 * numeric ranges, inclusive and exclusive respectively. `step=` is a parse
 * error upstream (decision D7) and never reaches here.
 */
function emitFor(ctx: EmitContext, el: MxElement): void {
  if (!el.params) fail("`<for>` without tag params (`|a, b|`)", el.name);
  const params = text(ctx, el.params)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const of = attrByName(el, "of");
  const inAttr = attrByName(el, "in");
  const from = attrByName(el, "from");
  const to = attrByName(el, "to");
  const until = attrByName(el, "until");

  if (attrByName(el, "step")) {
    fail(
      "`<for step=...>`: step is not supported; use a computed array",
      el.name,
    );
  }

  if (attrByName(el, "by")) {
    fail(
      "by= is not supported in a standalone template: string output has no reconciliation to key; remove by=",
      el.name,
    );
  }

  const [first = "item", second] = params;

  if (of) {
    const list = requireExpressionAttr(
      ctx,
      of,
      "`<for of=...>` requires an expression value",
      el.name,
    );
    if (second) {
      push(ctx, `for (const [${second}, ${first}] of ${list}.entries()) {`);
    } else {
      push(ctx, `for (const ${first} of ${list}) {`);
    }
    ctx.indent++;
    emitChildren(ctx, el.children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  if (inAttr) {
    const object = requireExpressionAttr(
      ctx,
      inAttr,
      "`<for in=...>` requires an expression value",
      el.name,
    );
    const key = first;
    const value = second ?? "value";
    push(ctx, `for (const [${key}, ${value}] of Object.entries(${object})) {`);
    ctx.indent++;
    emitChildren(ctx, el.children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  if (to || until) {
    // A written-but-valueless `from` is a mistake, not a request for the
    // default: silently treating it as 0 would compile a wrong range instead
    // of reporting it. Absent entirely is what defaults to 0 (decision D7).
    const start = from
      ? requireExpressionAttr(
          ctx,
          from,
          "`<for from=...>` requires an expression value",
          el.name,
        )
      : "0";
    const bound = requireExpressionAttr(
      ctx,
      to ?? until,
      "`<for>` requires `to=` or `until=`",
      el.name,
    );
    const compare = to ? "<=" : "<";
    push(
      ctx,
      `for (let ${first} = ${start}; ${first} ${compare} ${bound}; ${first}++) {`,
    );
    ctx.indent++;
    emitChildren(ctx, el.children);
    ctx.indent--;
    push(ctx, "}");
    return;
  }

  fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", el.name);
}

/** `<const/name=expr/>` -> a `const` at render scope. */
function emitConst(ctx: EmitContext, el: MxElement): void {
  if (!el.tagVar) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      el.name,
    );
  }
  const name = text(ctx, el.tagVar);
  const value = requireExpressionAttr(
    ctx,
    shorthandValue(el),
    "`<const>` without a value",
    el.name,
  );
  push(ctx, `const ${name} = ${value};`);
}

/** `<define/name|params|>...</define>` -> a local `(params) => string` function. */
function emitDefine(ctx: EmitContext, el: MxElement): void {
  if (!el.tagVar) {
    fail("`<define>` without a name (write `<define/name>`)", el.name);
  }
  const name = text(ctx, el.tagVar);
  const params = el.params ? text(ctx, el.params) : "";
  const paramNames = params
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const outer = ctx.body;
  const outerIndent = ctx.indent;
  ctx.body = [];
  ctx.indent = outerIndent + 1;
  push(ctx, 'let out = "";');
  emitChildren(ctx, el.children);
  push(ctx, "return out;");
  const lines = ctx.body;
  ctx.body = outer;
  ctx.indent = outerIndent;
  ctx.defines.set(name, paramNames);
  push(
    ctx,
    `const ${name} = (${params}) => {\n${lines.join("\n")}\n${INDENT.repeat(outerIndent)}};`,
  );
}

function emitElement(ctx: EmitContext, el: MxElement): void {
  const name = el.staticName;
  if (name === null) {
    fail("dynamic tag name is not supported in a standalone template", el.name);
  }

  switch (name) {
    case "for":
      emitFor(ctx, el);
      return;
    case "const":
      emitConst(ctx, el);
      return;
    case "define":
      emitDefine(ctx, el);
      return;
    case "else":
      fail("`<else>` without a preceding `<if>`", el.name);
      return;
    case "fragment":
      emitChildren(ctx, el.children);
      return;
  }

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      el.name,
    );
  }

  // A tag name that matches an in-scope binding — a `<define>` or an import —
  // is a component call regardless of case (Marko's own rule for custom
  // tags); anything else is an HTML element, whatever its case. The define
  // check comes first so a local shadows an import of the same name.
  if (ctx.defines.has(name) || ctx.imports.has(name)) {
    emitComponent(ctx, el);
    return;
  }

  // No HTML element is ever spelled with an uppercase first letter, so an
  // unbound PascalCase tag is not a plain element that happens to be
  // capitalized — it is a missing or misspelled import/define. Emitting it
  // as a literal element would be exactly the silent misroute this rule
  // exists to eliminate, just moved to a different case; failing loudly
  // instead turns a typo into a compile error rather than quietly wrong HTML.
  if (/^[A-Z]/.test(name)) {
    fail(
      `\`<${name}>\` has no matching import or \`<define>\` in scope; a capitalized tag is always a component call`,
      el.name,
    );
  }

  emitLiteral(ctx, `<${name}`);
  emitAttrs(ctx, el);

  if (isVoidTag(name)) {
    // Void elements take no closing tag and no children; htmljs-parser has
    // already rejected any children by this point (decision D13).
    emitLiteral(ctx, ">");
    return;
  }

  emitLiteral(ctx, ">");
  emitChildren(ctx, el.children);
  emitLiteral(ctx, `</${name}>`);
}

export function emitChildren(ctx: EmitContext, children: MxChild[]): void {
  // Comments render nothing, so they must not count as content when deciding
  // whether a text run touches a boundary — the whitespace around one trims
  // exactly as if it had not been written.
  const isContent = (child: MxChild) => child.kind !== "comment";
  const firstContent = children.findIndex(isContent);
  let lastContent = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child && isContent(child)) {
      lastContent = i;
      break;
    }
  }

  let index = 0;
  while (index < children.length) {
    const child = children[index] as MxChild;

    if (child.kind === "element" && child.element.staticName === "if") {
      index = emitIfChain(ctx, children, index);
      continue;
    }

    switch (child.kind) {
      case "text": {
        // The one whitespace implementation: Marko's line rule, shared with the
        // SolidMX target so the two cannot disagree about what an indented
        // template renders (decision D33).
        const value = normalizeText(
          text(ctx, child.range),
          index === firstContent,
          index === lastContent,
        );
        if (value !== null) emitLiteral(ctx, value);
        break;
      }

      case "placeholder":
        emitExpression(ctx, text(ctx, child.value), child.escape);
        break;

      case "element":
        emitElement(ctx, child.element);
        break;

      case "doctype":
        // Emitted verbatim, exactly as the author spelled it: `<!doctype html>`
        // and `<!DOCTYPE html>` are both legal and neither is worth rewriting.
        emitLiteral(ctx, text(ctx, child.range));
        break;

      case "comment": {
        // The recorded range is the comment's full source span, delimiters
        // included, so an HTML comment (`<!--`) and a line comment (`//`)
        // are distinguished by their first two characters. Only the HTML
        // form survives into the output; a line comment is author-only.
        const raw = text(ctx, child.range);
        if (raw.startsWith("<!--")) emitLiteral(ctx, raw);
        break;
      }
    }
    index++;
  }
}

/**
 * The local binding names an `import` statement introduces — default,
 * namespace, and every named import (`as`-aliased or not), in any
 * combination.
 *
 * Parsed for real rather than regex-scraped: a tag name is only a component
 * call when it names one of these bindings, so an incomplete extraction here
 * silently misroutes exactly the class of tag this file exists to route
 * correctly. `parseBabel` gives the same import grammar the author's `.ts`
 * would see; htmljs-parser only hands back the statement's source text
 * (AGENTS.md's "imports parse as tags" note), so it is re-parsed here the
 * same way `print`'s TypeScript erasure re-parses hoisted statements.
 */
function importBindings(line: string): string[] {
  const file = parseBabel(line, { sourceType: "module" });
  const declaration = file.program.body[0];
  if (declaration?.type !== "ImportDeclaration") return [];
  return declaration.specifiers.map((specifier) => specifier.local.name);
}

/**
 * Splits the author's statement lines into module-scope code and the `Input`
 * interface.
 *
 * `import` reaches module scope verbatim. `static const x = ...` drops its
 * `static` keyword and joins it there, running once per module rather than
 * once per render. `export interface Input` is lifted out so the emitted
 * module can place it above the render function it types.
 */
function collectStatements(ctx: EmitContext, statements: MxStatement[]): void {
  for (const statement of statements) {
    const line = text(ctx, statement.range).trim();
    if (statement.kind === "import") {
      ctx.hoisted.push(line);
      for (const name of importBindings(line)) ctx.imports.add(name);
      continue;
    }
    if (statement.kind === "static") {
      ctx.hoisted.push(line.replace(/^static\s+/, ""));
      continue;
    }
    // `export interface Input { ... }` is the only `export` a template may
    // carry: everything else it exports would have to be named at module
    // scope, and the module's single export is the render function.
    if (/^export\s+interface\s+Input\b/.test(line)) {
      ctx.inputInterface = line;
      continue;
    }
    fail(
      "a standalone template may only `export interface Input`; the module's default export is its render function",
      statement.range,
    );
  }
}

/**
 * Emits the complete TypeScript module for one parsed template.
 *
 * The module shape is fixed (decision S3): the escape import, the author's
 * hoisted module scope, their `Input` interface, and one default-exported
 * render function that concatenates into a single local.
 */
export function emitTemplate(template: MxTemplate, source: string): string {
  const ctx: EmitContext = {
    source,
    body: [],
    hoisted: [],
    inputInterface: null,
    defines: new Map(),
    imports: new Set(),
    indent: 1,
  };

  collectStatements(ctx, template.statements);
  emitChildren(ctx, template.children);

  const lines: string[] = ['import { escape } from "@markox/html";'];
  if (ctx.hoisted.length > 0) {
    lines.push("", ...ctx.hoisted);
  }
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

  // `input` is the render function's only parameter and a template that never
  // interpolates simply does not use it; TypeScript's unused-parameter check is
  // off by default, so no marker is needed.
  return lines.join("\n");
}
