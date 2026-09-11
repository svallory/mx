/**
 * `@markox/core`: the Marko-node consumer every MX host is built on.
 *
 * Compiles Marko's AST to a runtime-free `(input) => string` module, with
 * everything host-specific behind `Policy`. Decisions 70 to 72: MX is the
 * language, this package is the core, and a *host* (`@markox/translator` is
 * the vanilla one; SolidMX and Astro follow) supplies a policy plus its own
 * integration.
 *
 * The emit layer here is the core's **default string-emit model** —
 * buffering, `out +=` concatenation, `VOID_TAGS`, `DYNAMIC_TAG`, block
 * functions, the emitted module shape. Any host that emits strings reuses it
 * as is; a JSX host (phase 4) replaces the emit layer rather than pushing it
 * behind the policy, which is why these live as core functions and not as
 * policy members. See `README.md` "The emit model".
 *
 * This file previously served two dialects — `@markox/html`'s retired `.mx`
 * dialect, alongside `@markox/translator`'s stock `.marko` — until decision
 * 68 retired `.mx` and deleted `@markox/html` entirely. Two things that were
 * true while both existed, kept here because they still explain choices this
 * core makes:
 *
 * - **Tag disposition.** Decision 65 replaced "what my code can't do" with
 *   "what this target can't do": a construct either contributes output bytes
 *   (lower), only configures behaviour after the first render (inert), or
 *   evaluates to an initial value. The policy declares its own table.
 * - **Element resolution** asks Marko's taglib lookup, so a tag Marko adds or
 *   removes reaches it on a pin bump (ADR 0001's whole point) — `.mx`'s own
 *   hand-carried element set is gone with the rest of that dialect.
 *
 * Two shapes of Marko's AST drive nearly everything here, both measured
 * against 5.42.5 rather than assumed:
 *
 * - Whitespace is already decision 33. Marko's own `onText` drops a
 *   whitespace-only run containing a newline and collapses a newline-free run
 *   to one space, so `MarkoText.value` arrives normalized and this file does
 *   not re-normalize it.
 * - Statement tags (`import`, `static`, `export`) parse as *tags* whose
 *   attributes are word soup, and their `start`/`end` are undefined. Their
 *   `loc` line/column, however, spans exactly the statement, so the source
 *   text is sliced back out by `loc` and re-parsed.
 */

import { createRequire } from "node:module";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiler calls the same helper the emitted module imports, so a static value and a runtime one are escaped by one implementation
import { escape } from "./escape.ts";

const require = createRequire(import.meta.url);

/**
 * Marko's own bundled Babel — parser, traverse and types in one module.
 *
 * The core parses JS in two places (an `import` statement's bindings, and an
 * expression whose identifier references a host may rewrite). Both used
 * `@markox/parser`'s vendored Babel while this file lived in the translator,
 * which made the string host depend on the *SolidMX parser* package for a
 * plain `parse` call. `@marko/compiler` is already this package's only
 * dependency and already bundles a full Babel, and these nodes belong to that
 * instance anyway — so the core asks it, and `@markox/core` depends on
 * nothing else.
 *
 * Required lazily: `escape` and the type surface stay importable without
 * pulling in a 1.7MB bundle.
 */
function markoBabel(): {
  parse: (code: string, options?: Node) => Node;
  parseExpression: (code: string, options?: Node) => Node;
  traverse: Node;
  types: Node;
} {
  return require("@marko/compiler/internal/babel");
}

/**
 * Raised for a construct that parses as Marko but has no string lowering.
 *
 * Plain fields, not TS parameter properties: Node's native strip-only TS mode
 * (used by, among others, Vite's own build process when it loads this module
 * unbundled) rejects parameter properties outright, and this class is public
 * API that a consumer with no build step may import directly.
 */
export class TranslateError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "TranslateError";
    this.line = line;
    this.column = column;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Node = any;

const INDENT = "  ";

/**
 * A well-formed HTML attribute name, as source text for the emitted module.
 *
 * Validates spread keys, which are only known at run time. Anything containing
 * a space, quote, `/` or `>` could end the attribute name and start live markup
 * inside the tag, so it is skipped rather than emitted (decisions 42/44).
 */
const ATTR_NAME_PATTERN = "/^[A-Za-z_:][-A-Za-z0-9_:.]*$/";

export const VOID_TAGS = new Set([
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
 * How a dialect disposes of one tag name (decision 65).
 *
 * The test for every construct is whether it contributes to the emitted bytes
 * or only configures behaviour after the first render. "My code cannot lower
 * this" is never a disposition; only "this target cannot express it" is.
 */
export type Disposition =
  | {
      kind: "inert";
      reason: string;
      /**
       * The shape the tag is inert *in*, per its own Marko tag definition.
       *
       * Inert means "this construct emits nothing", never "whatever the author
       * wrote here may be discarded". A tag whose definition takes no body
       * still has to reject one, or authored markup disappears from a
       * successful compile — the silent-drop class (S8) the field guard exists
       * to close, reopened for every inert row.
       *
       * `body: "text"` is for a tag whose definition declares a raw-text body
       * (`<script>`): the text is genuinely consumed and emits nothing.
       */
      body?: "none" | "text";
      /**
       * Whether the tag's own definition accepts attributes beyond its value.
       *
       * Per tag, not uniform, because Marko is: `<effect foo="bar"/>` and
       * `<log=1 foo="bar"/>` are "does not support the `foo` attribute" there,
       * while `<lifecycle foo="bar"/>` compiles — a lifecycle tag's
       * attributes *are* its configuration. Verified against Marko for each
       * row.
       */
      attributes?: "none" | "any";
    }
  | { kind: "error"; reason: string };

export interface Policy {
  /** Tag names this dialect accepts with no output, or rejects, by name. */
  tags: Record<string, Disposition>;
  /** Whether a lowercase, unbound tag name is a real element. */
  isElement(name: string, ctx: Ctx): boolean;
  /** Emits a call to a component (an import, a `<define>`, or a discovered tag). */
  emitComponent(ctx: Ctx, node: Node, name: string): void;
  /** Whether `name` resolves to a component in this dialect. */
  isComponent(name: string, ctx: Ctx): boolean;
  /** Handles `class:foo="x"`-style attribute modifiers, or rejects them. */
  emitModifier?(ctx: Ctx, attr: Node): boolean;
  /**
   * Rewrites an attribute's value expression, for the attributes whose value
   * is structured rather than a plain string (`class`, `style`). Returning
   * undefined interpolates the author's expression unchanged.
   */
  attrValue?(ctx: Ctx, name: string, source: string): string | undefined;
  /** Lowers a `:=` bound attribute; true when it consumed it. */
  emitBoundAttr?(ctx: Ctx, attr: Node): boolean;
  /**
   * Reorders an element's attributes before they are emitted, for a dialect
   * whose target emits them in an order other than the author's.
   */
  orderAttrs?(tagName: string, attrs: Node[]): Node[];
  /**
   * Inspects a variable a construct is about to declare at *render* scope —
   * a `<let>` or `<const>` name. A dialect uses this to reject a name that
   * would collide with something the emitted module already binds.
   *
   * Deliberately not called for tag params (`<for|x|>`, `<define/R|x|>`):
   * those introduce a nested scope — a `for (const x of …)` head, an arrow
   * function's parameter list — where an ordinary JS shadow is correct and
   * harmless. Marko draws the same line, accepting `<for|input|>` while
   * rejecting `<let/input>` as a duplicate declaration.
   */
  checkBinding?(target: Node, what: string): void;
  /**
   * Whether an HTML comment reaches the output. Stock Marko drops every
   * comment; MX keeps `<!-- -->` and treats `//` as author-only.
   */
  keepComments?: boolean;
  /** The `import` specifier the emitted module's `escape` comes from. */
  escapeFrom: string;
  /** Lowers a tag this dialect handles specially; true when it consumed it. */
  emitSpecial?(ctx: Ctx, node: Node, name: string): boolean;
}

/**
 * A host's rewrite for references to one registered binding (decision 70).
 *
 * `register("count", ref => `${ref}()`)` makes `${count + 1}` emit
 * `count() + 1` in a host whose `<let>` is a Solid signal.
 */
export type BindingRewrite = (ref: string) => string;

/**
 * The registry of reference rewrites in scope (decision 70's third hook).
 *
 * Registration is flat rather than scoped: a name registered anywhere in the
 * template rewrites every later reference to it. That is enough for the
 * stateful tags this exists for (a `<let>` names a binding for the rest of
 * the render), and a host that needs block scoping registers and unregisters
 * around its own emit call.
 */
export interface BindingRegistry {
  register(name: string, rewrite: BindingRewrite): void;
  /** Forgets a registration, for a host unwinding a scope it opened. */
  unregister(name: string): void;
  /** The rewrite for `name`, or undefined when it is not registered. */
  get(name: string): BindingRewrite | undefined;
  /** Whether anything is registered at all — the fast path for `expr`. */
  get size(): number;
}

export interface Ctx {
  source: string;
  lines: string[];
  body: string[];
  hoisted: string[];
  /**
   * Statements to place at the head of the function currently being emitted
   * (decision 70's hoist hook). `hoist()` appends here; `blockFunction` and
   * `emitProgram` drain it into their own prelude, so a `const` hoisted from
   * inside an `<if>` lands at the enclosing function's top, not in the branch.
   */
  prelude: string[];
  /**
   * Lifts a statement to the head of the enclosing function — the render
   * function, or the nearest `blockFunction`.
   *
   * The hook a host needs for a stateful tag whose declaration must outlive
   * the block it was written in (a signal declared inside an `<if>` but read
   * after it). Emitted verbatim, at the function's own indent.
   */
  hoist(code: string): void;
  /** Reference rewrites for registered bindings; see `BindingRegistry`. */
  bindings: BindingRegistry;
  inputInterface: string | null;
  /** `<define>`s bound so far, name -> declared parameter names in order. */
  defines: Map<string, string[]>;
  /** Local bindings introduced by the template's `import` statements. */
  imports: Set<string>;
  indent: number;
  generate: (node: Node) => string;
  policy: Policy;
  /** Set by a dialect that resolves tags through Marko's taglib lookup. */
  lookup?: { getTag(name: string): { taglibId?: string } | undefined };
}

export function fail(message: string, node: Node): never {
  const loc = node?.loc?.start ?? node?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, loc.line ?? 0, loc.column ?? 0);
}

export function quote(text: string): string {
  return JSON.stringify(text);
}

export function push(ctx: Ctx, line: string): void {
  ctx.body.push(INDENT.repeat(ctx.indent) + line);
}

/**
 * Appends a run of literal HTML, merging into the preceding `out +=`.
 *
 * An element's tag, attributes and text would otherwise each take a line.
 */
export function emitLiteral(ctx: Ctx, text: string): void {
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

export function emitExpression(
  ctx: Ctx,
  expression: string,
  escaped: boolean,
): void {
  push(ctx, `out += ${escaped ? `escape(${expression})` : `(${expression})`};`);
}

/**
 * The source text an expression node came from, printed back to code.
 *
 * Identifier references to a name the host registered in `ctx.bindings` are
 * rewritten (decision 70's binding registry): with `count` registered to
 * `count()`, `count + 1` prints `count() + 1`.
 *
 * Precision limits, all deliberate and all tested:
 *
 * - Only *reference* positions are rewritten. A member's property name
 *   (`obj.count`), an object literal's non-shorthand key (`{ count: 1 }`) and
 *   a declaration's own binding identifier are left alone, because Babel's
 *   own `isReferencedIdentifier` says they are not references.
 * - Shadowing is **not** tracked, and that is a real wrong answer rather than a
 *   near miss: with `count` registered, `xs.map(count => count)` emits
 *   `xs.map(count => count())`, calling the parameter. Registered names are a
 *   host's own state bindings and an expression that shadows one is
 *   pathological, while tracking it would mean running Babel's scope analysis
 *   on every interpolation — so the limit is accepted and *pinned* by
 *   `hooks.test.ts`'s "rewrites a shadowing parameter too" case, which asserts
 *   the wrong output on purpose. Whoever fixes it will see that test fail and
 *   change the contract deliberately, instead of flipping behaviour silently.
 * - The walk runs only when something is registered, so a host that uses no
 *   stateful tags pays nothing.
 */
export function expr(ctx: Ctx, node: Node): string {
  if (ctx.bindings.size === 0) return ctx.generate(node);
  return ctx.generate(rewriteReferences(ctx, node));
}

/**
 * Clones an expression, replacing registered identifier references.
 *
 * The clone is a print-time concern only: the node reaching here belongs to
 * Marko's own AST, which the caller may emit again (an attribute read twice by
 * a policy, a condition re-printed by a diagnostic), so rewriting in place
 * would make the second print see the first one's output.
 *
 * The rewrite result is host-supplied *source text*, not a node, so it is
 * parsed back to an expression — that is what lets a host return anything
 * from `count()` to `untrack(() => count())` without building Babel nodes.
 */
function rewriteReferences(ctx: Ctx, node: Node): Node {
  const { types, traverse, parseExpression } = markoBabel();
  const clone = types.cloneNode(node, true);
  // A bare identifier is never "referenced" as a lone expression to traverse
  // (there is no parent to ask), so it is handled before the walk.
  if (clone.type === "Identifier") {
    const rewrite = ctx.bindings.get(clone.name);
    return rewrite ? parseExpression(rewrite(clone.name)) : clone;
  }
  // `traverse` needs a Program to walk, and these nodes came out of Marko's
  // own Babel instance, so its bundled traverse is the one that knows them.
  const file = types.file(
    types.program([types.expressionStatement(clone as Node)]),
  );
  traverse(file, {
    // biome-ignore lint/style/useNamingConvention: a Babel visitor key is a node type
    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      const rewrite = ctx.bindings.get(path.node.name);
      if (!rewrite) return;
      path.replaceWith(parseExpression(rewrite(path.node.name)));
      path.skip();
    },
  });
  return file.program.body[0].expression;
}

/**
 * The statement's own source text.
 *
 * `import`/`static`/`export` arrive as tags whose attributes are word soup and
 * whose `start`/`end` are undefined; only `loc` spans the statement, so the
 * text is recovered by line/column and handed back to a real JS parser.
 */
export function sliceLoc(ctx: Ctx, loc: Node): string {
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
export function importBindings(line: string): string[] {
  try {
    const file = markoBabel().parse(line, { sourceType: "module" });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return [];
    return declaration.specifiers.map((s: Node) => s.local.name);
  } catch {
    return [];
  }
}

/** True when a child list holds anything that renders. */
export function hasContent(children: Node[]): boolean {
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
export function blockFunction(ctx: Ctx, children: Node[], params = ""): string {
  const outer = ctx.body;
  const outerIndent = ctx.indent;
  const outerPrelude = ctx.prelude;
  ctx.body = [];
  ctx.prelude = [];
  ctx.indent = outerIndent + 1;
  push(ctx, 'let out = "";');
  emitChildren(ctx, children);
  push(ctx, "return out;");
  const lines = ctx.body;
  // A statement hoisted from inside this block belongs at *this* function's
  // head, not the enclosing one's: it may read the block's own params.
  const prelude = ctx.prelude.map(
    (code) => INDENT.repeat(outerIndent + 1) + code,
  );
  ctx.body = outer;
  ctx.prelude = outerPrelude;
  ctx.indent = outerIndent;
  return `(${params}) => {\n${[...prelude, ...lines].join("\n")}\n${INDENT.repeat(outerIndent)}}`;
}

/**
 * Rejects the node fields this translator does not read.
 *
 * Marko's parser fills in more than the string target lowers: attribute tags,
 * tag arguments, a tag variable and type arguments are all separated out of
 * the body at parse time, so a path that walks only `body.body` renders none
 * of them and reports nothing. That is the silent-drop failure S8 exists to
 * close — the same class as `by=`, and worse, because whole authored content
 * disappears from a successful compile.
 *
 * One guard rather than a check per emission path: seven scattered copies
 * would drift, and the next field Marko adds would be dropped by whichever
 * copy was forgotten.
 *
 * `allow` names the fields the calling path genuinely lowers — only a
 * component call reads `attributeTags`, and only `<define>`/`<const>` read
 * `var`. An *inert* field is declared here too rather than ignored: decision
 * 65 accepts a construct with no output effect, but the guard still has to
 * know it was considered, or the next silently-dropped field looks exactly
 * like an intentionally inert one.
 */
export function rejectUnsupportedFields(
  ctx: Ctx,
  node: Node,
  what: string,
  allow: {
    attributeTags?: boolean;
    var?: boolean;
    params?: boolean;
    args?: boolean;
  } = {},
): void {
  if (!allow.attributeTags && node.attributeTags?.length) {
    const first = node.attributeTags[0];
    const tagName = String(first?.name?.value ?? "@…").replace(/^@/, "");
    fail(
      `attribute tag \`@${tagName}\` on ${what}; attribute tags are props of components, so they are only valid directly inside a component call`,
      first ?? node,
    );
  }
  if (!allow.args && node.arguments) {
    fail(
      `tag arguments \`(...)\` on ${what} are not supported in a standalone template`,
      node,
    );
  }
  if (!allow.var && node.var) {
    fail(
      `tag variable \`/${expr(ctx, node.var)}\` on ${what} is not supported in a standalone template`,
      node,
    );
  }
  if (node.typeArguments || node.body?.typeParameters) {
    fail(
      `type arguments on ${what} are not supported in a standalone template`,
      node,
    );
  }
  if (!allow.params && node.body?.params?.length) {
    fail(
      `tag params \`|...|\` on ${what} are not supported in a standalone template`,
      node,
    );
  }
}

/**
 * Enforces that an inert tag appears in the shape its own definition allows.
 *
 * A tag is inert because *it* emits nothing, not because anything written
 * inside it may be thrown away. `<effect><div>x</div></effect>` compiled clean
 * with the `<div>` gone before this existed — a successful compile that
 * silently deleted authored markup, which is the exact failure class (S8) the
 * field guard was built to close.
 *
 * The declared shapes come from each tag's own Marko definition, and the
 * outcomes match what Marko itself does: `<effect>` with a body is
 * "does not support body content" there, an unknown attribute is "does not
 * support the `foo` attribute", and `<lifecycle>`/`<id>`/`<log>`/`<debug>` are
 * `openTagOnly` so a body is a parse error before any translator sees it.
 */
function rejectInertShape(
  ctx: Ctx,
  node: Node,
  name: string,
  disposition: Extract<Disposition, { kind: "inert" }>,
): void {
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, {
    params: true,
    args: true,
    var: true,
  });

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      fail(
        `spread attributes on \`<${name}>\` are not supported: the tag emits nothing, so a spread's keys would be silently discarded`,
        attr,
      );
    }
    if (disposition.attributes !== "none") continue;
    // A control tag's own value attribute (`<log=x/>`) is spelled `value` or
    // marked `default` by the parser depending on the form; either way it is
    // the tag's own argument, not an extra. An `effect() { … }` body arrives
    // as an attribute with `arguments`, which is likewise the tag's own.
    if (attr.name === "value" || attr.default || attr.arguments) continue;
    fail(
      `\`<${name}>\` does not support the \`${attr.name}\` attribute; it emits nothing, so the attribute would be silently discarded`,
      attr,
    );
  }

  if (disposition.body === "text") return;
  if (hasContent(node.body?.body ?? [])) {
    fail(
      `\`<${name}>\` does not support body content; it emits nothing, so the body would be silently discarded`,
      node,
    );
  }
}

export function attrByName(node: Node, name: string): Node | undefined {
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
export function emitAttrs(ctx: Ctx, node: Node): void {
  const attributes = ctx.policy.orderAttrs
    ? ctx.policy.orderAttrs(
        String(node.name?.value ?? ""),
        node.attributes ?? [],
      )
    : (node.attributes ?? []);
  for (const attr of attributes) {
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
    if (attr.bound && !ctx.policy.emitBoundAttr?.(ctx, attr)) {
      fail(
        "`:=` is a two-way binding and requires a reactive runtime; standalone MX renders once to a string",
        attr,
      );
    }
    if (attr.bound) continue;
    // `class:foo="x"` is a modifier Marko hands over as the base name plus a
    // modifier. Emitting only the base name renders `class="x"` — not a drop
    // but a *wrong* attribute, which is worse: the author's intent silently
    // becomes different markup. A dialect that lowers modifiers says so.
    if (attr.modifier) {
      if (ctx.policy.emitModifier?.(ctx, attr)) continue;
      fail(
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
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
    // `class` and `style` accept structured values in Marko (an object of
    // toggles, an array of either), which render as a joined string rather
    // than as the value's own `String()` form. A dialect that supports them
    // rewrites the expression; everything else interpolates as-is.
    const source =
      ctx.policy.attrValue?.(ctx, attr.name, expr(ctx, value)) ??
      expr(ctx, value);
    // A structured value renders itself; interpolating it into quotes would
    // double-escape the separators the helper already produced.
    const omitEmpty = source !== expr(ctx, value);
    if (omitEmpty) {
      push(ctx, `{`);
      ctx.indent++;
      push(ctx, `const value = ${source};`);
      push(
        ctx,
        `if (value !== "") out += " ${attr.name}=\\"" + value + "\\"";`,
      );
      ctx.indent--;
      push(ctx, `}`);
      continue;
    }
    emitLiteral(ctx, ` ${attr.name}="`);
    emitExpression(ctx, source, true);
    emitLiteral(ctx, '"');
  }
}

export function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/**
 * All five `<for>` forms, each lowered to the plain JS loop that matches it.
 *
 * `by=` is *inert* (decision 65): it is reconciler input, naming which item a
 * DOM node belongs to across re-renders. A one-shot string render performs no
 * reconciliation, so it changes no emitted byte — verified against Marko
 * itself, whose server render produces identical output with and without it.
 * That is why it is accepted here rather than rejected: "this target ignores
 * it" is a fact about the target, and Marko's own renderer ignores it too.
 */
export function emitFor(ctx: Ctx, node: Node): void {
  if (attrByName(node, "step")) {
    fail("`<for step=...>`: step is not supported; use a computed array", node);
  }

  rejectUnsupportedFields(ctx, node, "`<for>`", { params: true });

  const params: string[] = (node.body?.params ?? []).map((p: Node) =>
    expr(ctx, p),
  );
  // A `<for>` with no params names no loop variable. Defaulting it to `item`
  // would bind the body to a name the author never wrote — resolving to an
  // outer-scope `item` if one exists, or failing at render time instead of
  // compile time. The old emitter rejected this and so does this one.
  if (params.length === 0) {
    fail("`<for>` needs tag params: `<for|item| of=…>`", node);
  }
  const [first = "item", second] = params;
  const children = node.body?.body ?? [];

  /**
   * Binds a loop's own expressions to temporaries *before* the loop opens.
   *
   * A tag param may legitimately shadow an outer name — `<for|input| of=
   * input.items>` is valid Marko and renders there — but the loop variable is
   * in scope throughout its own head, so emitting `for (const input of
   * input.items)` puts `input.items` in the temporal dead zone and throws
   * "Cannot access 'input' before initialization" at render time. Evaluating
   * the iterable first is what makes an ordinary JS shadow behave the way the
   * author (and Marko) expect.
   */
  const bind = (source: string): string => {
    const temp = `$for${ctx.body.length}`;
    push(ctx, `const ${temp} = ${source};`);
    return temp;
  };

  const of = attrByName(node, "of");
  if (of) {
    const list = bind(expr(ctx, of.value));
    if (second) {
      push(
        ctx,
        `for (const [${second}, ${first}] of [...${list}].entries()) {`,
      );
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
    const object = bind(expr(ctx, inAttr.value));
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
    const start = bind(from ? expr(ctx, from.value) : "0");
    const bound = bind(expr(ctx, (to ?? until).value));
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
export function emitConst(ctx: Ctx, node: Node): void {
  if (!node.var) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, "`<const>`", { var: true });
  // `<const>` is dispatched by the core switch, before a policy's own
  // `emitSpecial` ever sees it, so the binding check has to happen here or a
  // dialect's rule silently applies to `<let>` and not to `<const>`.
  ctx.policy.checkBinding?.(node.var, "`<const>`");
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  if (!value?.value) fail("`<const>` without a value", node);
  push(ctx, `const ${expr(ctx, node.var)} = ${expr(ctx, value.value)};`);
}

/** `<define/name|params|>...</define>` -> a local `(params) => string`. */
export function emitDefine(ctx: Ctx, node: Node): void {
  if (!node.var) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  rejectUnsupportedFields(ctx, node, "`<define>`", {
    var: true,
    params: true,
  });
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
export function emitIfChain(ctx: Ctx, children: Node[], index: number): number {
  const node = children[index];
  rejectUnsupportedFields(ctx, node, "`<if>`");
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
export function emitStatement(ctx: Ctx, node: Node, name: string): void {
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

/**
 * The name `emitSpecial` receives for a dynamic tag (`<${expr}/>`).
 *
 * A sentinel rather than a real tag name, so it can never collide with a
 * name an author wrote. Exported so that a policy matches the same value the
 * core passes: two hand-typed copies of a sentinel is exactly the drift that
 * makes one side silently stop matching.
 */
export const DYNAMIC_TAG = "\u0000dynamic";

function emitTag(ctx: Ctx, node: Node): void {
  // A bare `${expr}` on its own line parses as a tag whose *name* is the
  // expression, with no attributes and no body — Marko's concise mode has no
  // other shape for it. Treated as the escaped placeholder the author wrote.
  if (node.name && node.name.type !== "StringLiteral") {
    if ((node.attributes ?? []).length === 0 && !node.body?.body?.length) {
      if (ctx.policy.emitSpecial?.(ctx, node, DYNAMIC_TAG)) return;
      emitExpression(ctx, expr(ctx, node.name), true);
      return;
    }
    if (ctx.policy.emitSpecial?.(ctx, node, DYNAMIC_TAG)) return;
    fail("dynamic tag name is not supported in a standalone template", node);
  }

  const name = String(node.name.value);

  const disposition = ctx.policy.tags[name];
  if (disposition) {
    if (disposition.kind === "error") fail(disposition.reason, node);
    rejectInertShape(ctx, node, name, disposition);
    return;
  }

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
    case "else":
    case "else-if":
      fail(`\`<${name}>\` without a preceding \`<if>\``, node);
      return;
  }

  if (ctx.policy.emitSpecial?.(ctx, node, name)) return;

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      node,
    );
  }

  if (ctx.policy.isComponent(name, ctx)) {
    ctx.policy.emitComponent(ctx, node, name);
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
  // the silent-failure mode ADR 0001 names: a core tag the dialect has no
  // lowering for must be an error, never a literal element.
  if (!ctx.policy.isElement(name, ctx)) {
    fail(
      `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }

  rejectUnsupportedFields(ctx, node, `\`<${name}>\``);

  emitLiteral(ctx, `<${name}`);
  emitAttrs(ctx, node);
  emitLiteral(ctx, ">");

  if (VOID_TAGS.has(name)) return;

  emitChildren(ctx, node.body?.body ?? []);
  emitLiteral(ctx, `</${name}>`);
}

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
        // Whether an HTML comment reaches the output at all is a dialect
        // question: stock Marko drops every comment, MX keeps `<!-- -->` and
        // treats `//` as author-only.
        if (
          ctx.policy.keepComments &&
          sliceLoc(ctx, child.loc).startsWith("<!--")
        ) {
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
 * A fresh emit context, with the three stateful-tag hooks wired.
 *
 * Exported because a host — and the hook tests — need a context without going
 * through `emitProgram`'s whole module shape.
 */
export function newCtx(
  source: string,
  generate: (node: Node) => string,
  policy: Policy,
  lookup?: Ctx["lookup"],
): Ctx {
  const rewrites = new Map<string, BindingRewrite>();
  const ctx: Ctx = {
    source,
    lines: source.split("\n"),
    body: [],
    hoisted: [],
    prelude: [],
    hoist(code: string) {
      ctx.prelude.push(code);
    },
    bindings: {
      register(name, rewrite) {
        rewrites.set(name, rewrite);
      },
      unregister(name) {
        rewrites.delete(name);
      },
      get(name) {
        return rewrites.get(name);
      },
      get size() {
        return rewrites.size;
      },
    },
    inputInterface: null,
    defines: new Map(),
    imports: new Set(),
    indent: 1,
    generate,
    policy,
    lookup,
  };
  return ctx;
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
  policy: Policy,
  lookup?: Ctx["lookup"],
): string {
  const ctx = newCtx(source, generate, policy, lookup);

  emitChildren(ctx, body);

  const lines: string[] = [`import { escape } from "${policy.escapeFrom}";`];
  if (ctx.hoisted.length > 0) lines.push("", ...ctx.hoisted);
  lines.push(
    "",
    ctx.inputInterface ?? "export interface Input {}",
    "",
    "export default function (input: Input): string {",
    `${INDENT}let out = "";`,
    // Hoisted statements precede the body but follow `out`, so a hoisted
    // declaration may not reference the buffer — which is the point: it is a
    // declaration, not output.
    ...ctx.prelude.map((code) => INDENT + code),
    ...ctx.body,
    `${INDENT}return out;`,
    "}",
    "",
  );
  return lines.join("\n");
}
