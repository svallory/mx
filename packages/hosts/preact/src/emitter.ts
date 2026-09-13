/**
 * The MX → Preact emitter, over `@mxlang/core`'s IR (decisions 79, 81, 82).
 *
 * The fourth emitter on the shared IR, and the one whose target has no
 * control-flow components at all: where Solid has `<Show>`/`<For>` and Astro
 * has its own template syntax, Preact has plain JSX plus JavaScript. So every
 * structural kind lowers to an *expression* — a ternary chain for `<if>`, a
 * `.map` call for `<for>` — exactly as a Preact author would write by hand.
 *
 * Nothing here walks a Marko node: `resolve()` already decided every
 * host-specific question through `preactDeclarations` below, and what arrives
 * is IR kinds, printed expressions and positions.
 *
 * ## Why the target is a parameter
 *
 * React's lowering is this lowering. The two differ in a handful of *names*
 * (`preact` vs `react` as the JSX import source, `class` vs `className`, which
 * module the error boundary comes from), so those live in `Target` and a React
 * package can reuse this file rather than fork it. See `target.ts` for what
 * belongs in that object and what does not.
 */

import {
  type Attr,
  type AttributeTag,
  drive,
  type Emitter,
  type Expr,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type Position,
  TranslateError,
} from "@mxlang/core";
import { preactTarget, type Target } from "./target.ts";

/**
 * The Marko tags this host refuses, each naming what to write instead.
 *
 * Same shape as `@mxlang/solid`'s table, and for the same reason: these are
 * Marko's *own* reactivity, and this target has its own. Decision 65's rule
 * holds — the message says what this target cannot express and where the
 * equivalent lives, never "not implemented".
 */
const STATEFUL_ERRORS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is Marko reactive state; use Preact's `useState` via `<const/x=useState(0)/>` or in the surrounding module",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a Marko reactive effect; use Preact's `useEffect` via `<const/_=useEffect(...)/>` or in the surrounding module",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a Marko lifecycle hook; use Preact's `useEffect`/`useLayoutEffect` instead",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` is a Marko client-runtime tag; write client code in a module the component imports",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is Marko's client-runtime split; a Preact component is already client code",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for Marko's reactive runtime; use Preact's `useId`",
  },
  await: {
    kind: "error",
    reason:
      "`<await>` needs Marko's suspense; use `<try>` with a `<@placeholder>`, whose body may suspend",
  },
  return: {
    kind: "error",
    reason:
      "`<return>` hands a value to a parent template; a Preact component returns its own markup",
  },
  else: { kind: "error", reason: "`<else>` must follow an `<if>`" },
  "else-if": { kind: "error", reason: "`<else-if>` must follow an `<if>`" },
};

/** What `resolveHostTag` records for a claimed tag. */
type HostTagData = { kind: "try" };

function fail(message: string, node: { loc: Position }): never {
  throw new TranslateError(message, node.loc.line, node.loc.column);
}

function rawFail(message: string, node: { loc?: { start?: Position } }): never {
  const { line, column } = node.loc?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, line, column);
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Resolve-time questions for a Preact/React JSX target. */
export const preactDeclarations: HostDeclarations = {
  tags: STATEFUL_ERRORS,
  isElement: (name) => !isComponentName(name),
  isComponent: (name) => isComponentName(name),
  claimsTag: (name) => name === "try",
  resolveHostTag(name, node): HostTagData {
    if (name !== "try") rawFail(`unknown Preact host tag ${name}`, node);
    if (node.body?.params?.length) {
      rawFail("tag params (`|a, b|`) on `<try>`", node);
    }
    if (node.var) rawFail("tag variable (`/name`) on `<try>`", node);
    if (node.arguments) rawFail("tag arguments `(...)` on `<try>`", node);
    if ((node.attributes ?? []).length > 0) {
      rawFail("attributes on `<try>` are not supported", node.attributes[0]);
    }

    const seen = new Set<string>();
    for (const tag of node.attributeTags ?? []) {
      const tagName = String(tag.name?.value ?? "").replace(/^@/, "");
      if (tagName !== "catch" && tagName !== "placeholder") {
        rawFail(`attribute tag \`<@${tagName}>\` inside \`<try>\``, tag);
      }
      if (seen.has(tagName)) {
        rawFail(
          `attribute tag \`@${tagName}\` given twice (repeatable attribute tags are not supported)`,
          tag,
        );
      }
      seen.add(tagName);
      if ((tag.attributes ?? []).length > 0) {
        rawFail(
          "attribute tags take params or a body, not attributes (v1)",
          tag,
        );
      }
      if (tagName === "placeholder" && tag.body?.params?.length) {
        rawFail("tag params (`|a, b|`) on `<@placeholder>`", tag);
      }
    }
    return { kind: "try" };
  },
  rejectModifier(attr) {
    rawFail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not Preact syntax; write the prop directly (\`class={{ active: cond }}\` rather than \`class:active\`)`,
      attr,
    );
  },
  // An attribute method (`<button onClick() { … }>`) is an ordinary callable
  // prop in JSX, so this target carries it rather than rejecting it.
  resolveAttributeMethod: () => true,
};

/**
 * Escapes text for a JSX child position.
 *
 * `{` and `}` open and close an expression container in JSX, so literal
 * braces in template text become entities; left raw they would be parsed as
 * an expression and either fail to compile or silently swallow the text.
 */
function escapeText(value: string): string {
  return value.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The source text of a `FunctionExpression` attribute value, as an arrow.
 *
 * Marko's attribute-method shorthand (`onClick() { … }`) parses as a function
 * expression. Emitted verbatim into JSX it is still valid, but an arrow keeps
 * `this` lexical, which is what a Preact author writing the same handler by
 * hand would get.
 */
function methodExpression(expr: Expr): string | null {
  if (expr.node?.type !== "FunctionExpression") return null;
  const match = expr.code.match(
    /^(async\s+)?function\s*\(([\s\S]*)\)\s*(\{[\s\S]*\})$/,
  );
  if (!match) return expr.code;
  return `${match[1] ?? ""}(${match[2] ?? ""}) => ${match[3] ?? "{}"}`;
}

/** The text of a template literal with no dynamic parts, or null. */
function staticTemplateValue(expr: Expr): string | null {
  const node = expr.node;
  if (node?.type !== "TemplateLiteral") return null;
  const expressions = node.expressions ?? [];
  if (
    expressions.some(
      (item: { type?: string }) => item?.type !== "StringLiteral",
    )
  ) {
    return null;
  }
  let value = "";
  for (let index = 0; index < (node.quasis ?? []).length; index++) {
    value += node.quasis[index]?.value?.cooked ?? "";
    value += expressions[index]?.value ?? "";
  }
  return value;
}

function meaningful(nodes: IrNode[]): IrNode[] {
  return nodes.filter(
    (node) =>
      node.kind !== "Comment" && !(node.kind === "Text" && node.value === ""),
  );
}

/** The sole `$!{expr}` child of a node, when that is all it has. */
function rawChild(
  nodes: IrNode[],
): Extract<IrNode, { kind: "Interpolation" }> | null {
  const content = meaningful(nodes);
  if (content.length !== 1) return null;
  const only = content[0];
  return only?.kind === "Interpolation" && !only.escaped ? only : null;
}

/**
 * Rejects `$!{expr}` beside other children.
 *
 * Raw HTML is set through a *prop* on both targets, which replaces the whole
 * subtree — so a raw placeholder with siblings would silently drop them.
 * Refusing is decision 65's rule: the target genuinely cannot express it.
 */
function rejectMixedRaw(nodes: IrNode[]): void {
  const content = meaningful(nodes);
  const raw = content.find(
    (node): node is Extract<IrNode, { kind: "Interpolation" }> =>
      node.kind === "Interpolation" && !node.escaped,
  );
  if (raw && content.length !== 1) {
    fail("raw placeholder (`$!{…}`) must be the only child", raw);
  }
}

function hasNamedAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => attr.kind !== "spread" && attr.name === name);
}

function identifierNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

/** A loop-counter name that cannot shadow anything the body already uses. */
function hygienicName(base: string, params: string[], body: string): string {
  const used = identifierNames(`${params.join(" ")} ${body}`);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}

/** Preact JSX text emitter over the shared core IR. */
export class PreactEmitter implements Emitter<string> {
  readonly #out: string[] = [];
  readonly #target: Target;
  /**
   * Runtime names this emitter's output needs an import for.
   *
   * Collected while emitting rather than scanned for afterwards, so a template
   * that never writes `<try>` emits no import at all and the emitted module's
   * dependency list is exactly what it uses.
   */
  readonly #runtimeImports: Set<string>;

  constructor(target: Target = preactTarget, runtimeImports?: Set<string>) {
    this.#target = target;
    this.#runtimeImports = runtimeImports ?? new Set();
  }

  /** The runtime helper names this emitter's output references. */
  get runtimeImports(): Set<string> {
    return this.#runtimeImports;
  }

  /** A child emitter sharing this one's target and import collection. */
  #child(): PreactEmitter {
    return new PreactEmitter(this.#target, this.#runtimeImports);
  }

  #render(nodes: IrNode[]): string {
    const child = this.#child();
    drive(child, nodes);
    return child.done();
  }

  /**
   * A child list as a single JSX *expression*.
   *
   * One element stays itself; anything else is wrapped in a fragment, because
   * a ternary branch and a `.map` callback each have exactly one expression
   * slot to fill. A lone escaped placeholder becomes its bare expression,
   * which keeps `<if=c>${x}</if>` from emitting `<>{x}</>`.
   */
  #expression(nodes: IrNode[]): string {
    const content = meaningful(nodes);
    if (content.length === 0) return "null";
    if (content.length === 1) {
      const only = content[0] as IrNode;
      if (only.kind === "Interpolation" && only.escaped) return only.expr.code;
      if (
        only.kind === "Element" ||
        only.kind === "Component" ||
        only.kind === "IfChain" ||
        only.kind === "For" ||
        only.kind === "HostTag"
      ) {
        return this.#render(content);
      }
    }
    return `<>${this.#render(content)}</>`;
  }

  #attr(attr: Attr): string {
    switch (attr.kind) {
      case "spread":
        return ` {...${attr.value.code}}`;
      case "boolean":
        return ` ${attr.name}={true}`;
      case "static":
        return ` ${this.#attrName(attr.name)}="${escapeAttribute(attr.value)}"`;
      case "bound":
        // `value:=x` binds two ways in Marko: the value renders *and* edits
        // write back. Preact has no two-way binding — a controlled input is a
        // value prop plus an explicit handler — so emitting only the value
        // would produce an input the user cannot type into.
        return fail(
          "`:=` is Marko's two-way binding; Preact has no equivalent — pass the value and an explicit `onInput` handler",
          attr,
        );
      case "dynamic": {
        const name = this.#attrName(attr.name);
        // A `class` written as a template literal with no dynamic parts is a
        // constant, and reads better as one in the emitted JSX.
        if (attr.name === "class") {
          const fixed = staticTemplateValue(attr.value);
          if (fixed !== null) return ` ${name}="${escapeAttribute(fixed)}"`;
          if (attr.value.shape === "object" || attr.value.shape === "array") {
            // Marko's structured class value; Preact's `class` takes a string,
            // so the object/array form is joined by the emitted helper.
            this.#runtimeImports.add("mxClass");
            return ` ${name}={mxClass(${attr.value.code})}`;
          }
        }
        if (attr.name === "style" && attr.value.shape !== "object") {
          // Preact's `style` prop takes an object or a string; anything else
          // (an identifier, a call) could be either at run time and Marko's own
          // rule is object-only, so the mismatch is refused rather than guessed.
          return fail(
            "`style=` takes an object literal (`style={color: c}`); a non-object value is not supported",
            attr,
          );
        }
        return ` ${name}={${methodExpression(attr.value) ?? attr.value.code}}`;
      }
    }
  }

  /** An attribute name in this target's spelling. */
  #attrName(name: string): string {
    return name === "class" ? this.#target.classAttr : name;
  }

  /**
   * Every attribute of one tag.
   *
   * No merging or duplicate checking happens here, and that is deliberate:
   * Marko folds `.card class=value` into one synthetic array attribute before
   * the resolver ever sees it (the helper joins that array), and it rejects
   * `#id` beside an explicit `id=` in its own parser — *"Cannot have shorthand
   * id and id attribute"* — so a check here would be unreachable code
   * pretending to be a guard.
   */
  #attrs(attrs: Attr[]): string {
    return attrs.map((attr) => this.#attr(attr)).join("");
  }

  /** An attribute tag as a prop: a value, or a function when it has params. */
  #attributeTag(tag: AttributeTag): string {
    const value = this.#expression(tag.block.children);
    if (!tag.block.hasParams) return ` ${tag.name}={${value}}`;
    return ` ${tag.name}={(${tag.block.params.join(", ")}) => ${value}}`;
  }

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    this.#out.push(escapeText(node.value));
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (!node.escaped) {
      fail("raw placeholder (`$!{…}`) must be the only child", node);
    }
    this.#out.push(`{${node.expr.code}}`);
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    rejectMixedRaw(node.children);
    const raw = rawChild(node.children);
    if (raw && hasNamedAttr(node.attrs, this.#target.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#target.rawHtmlProp}=\` attribute`,
        raw,
      );
    }
    const attrs = this.#attrs(node.attrs);
    const rawHtml = raw
      ? ` ${this.#target.rawHtmlProp}={${this.#target.rawHtmlValue(raw.expr.code)}}`
      : "";
    if (node.void) {
      this.#out.push(`<${node.name}${attrs}${rawHtml} />`);
      return;
    }
    const children = raw ? "" : this.#render(node.children);
    if (children === "") {
      this.#out.push(`<${node.name}${attrs}${rawHtml} />`);
      return;
    }
    this.#out.push(
      `<${node.name}${attrs}${rawHtml}>${children}</${node.name}>`,
    );
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    if (node.target.kind === "dynamic") {
      // A dynamic tag name is a component *value* in JSX, and JSX requires a
      // capitalized identifier in tag position — so the expression has to be
      // bound to one first, which a template expression cannot do.
      //
      // The core refuses one before it reaches here, since this host declares
      // no `claimsTag` for `DYNAMIC_TAG`; the branch stays because `Component`
      // carries the case in its type and silently emitting nothing for it
      // would drop authored markup from a successful compile. Note a *bare*
      // `<${expr}/>` never arrives here at all: with no attributes and no body
      // that is Marko's placeholder shape, and it resolves to an ordinary
      // interpolation.
      fail(
        "a dynamic tag name (`<${expr}>`) cannot be a JSX tag; bind the component to a capitalized name in the surrounding module",
        node,
      );
    }
    if (node.target.kind === "define") {
      // A `<define>` is a local block; this host lowers one to a local
      // function (see `define` below), so calling it is an ordinary call.
      const args =
        node.args.length > 0
          ? node.args.map((arg: Expr) => arg.code).join(", ")
          : this.#defineProps(node);
      this.#out.push(`{${node.target.name}(${args})}`);
      return;
    }

    const name = node.target.name;
    const contentNodes = node.content?.children ?? [];
    rejectMixedRaw(contentNodes);
    const raw = node.content ? rawChild(contentNodes) : null;
    if (raw && hasNamedAttr(node.attrs, this.#target.rawHtmlProp)) {
      fail(
        `\`$!{…}\` sole child combined with an explicit \`${this.#target.rawHtmlProp}=\` attribute`,
        raw,
      );
    }

    const attrs = this.#attrs(node.attrs);
    const tags = node.attributeTags
      .map((tag) => this.#attributeTag(tag))
      .join("");
    const rawHtml = raw
      ? ` ${this.#target.rawHtmlProp}={${this.#target.rawHtmlValue(raw.expr.code)}}`
      : "";
    if (!node.content || raw) {
      this.#out.push(`<${name}${attrs}${tags}${rawHtml} />`);
      return;
    }

    // Tag params make the children a render prop — `<For|item| each=…>` is
    // the shape that lets a Preact component taking a function child be
    // called from MX. Without params the children are ordinary JSX children.
    const children = node.content.hasParams
      ? `{(${node.content.params.join(", ")}) => ${this.#expression(contentNodes)}}`
      : this.#render(contentNodes);
    if (children === "") {
      this.#out.push(`<${name}${attrs}${tags} />`);
      return;
    }
    this.#out.push(`<${name}${attrs}${tags}>${children}</${name}>`);
  }

  /** The props object for a `<define>` called by name rather than positionally. */
  #defineProps(node: Extract<IrNode, { kind: "Component" }>): string {
    if (node.target.kind !== "define") return "";
    const named = new Map<string, string>();
    for (const attr of node.attrs) {
      if (attr.kind === "spread") continue;
      named.set(
        attr.name,
        attr.kind === "boolean"
          ? "true"
          : attr.kind === "static"
            ? JSON.stringify(attr.value)
            : attr.value.code,
      );
    }
    return node.target.params
      .map((param) => named.get(param) ?? "undefined")
      .join(", ");
  }

  /**
   * `<if>`/`<else-if>`/`<else>` as a ternary chain.
   *
   * Preact has no conditional component, so this is what an author writes by
   * hand. A chain with no `<else>` ends in `null`, which renders nothing —
   * the same result Marko gives for an unmatched `<if>`.
   */
  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    const parts: string[] = [];
    for (const branch of node.branches) {
      if (branch.condition) {
        parts.push(
          `${branch.condition.code} ? ${this.#expression(branch.children)} : `,
        );
      } else {
        parts.push(this.#expression(branch.children));
      }
    }
    if (node.branches.at(-1)?.condition) parts.push("null");
    this.#out.push(`{${parts.join("")}}`);
  }

  /**
   * Every `<for>` form as `.map`, with a `key` on each row.
   *
   * `key` is what lets Preact reconcile a list across renders, and a list
   * without one re-creates its rows. MX's `by=` is that key when the author
   * gives one; when they do not, the key is the row's own identity — the item
   * for `of`, the property name for `in`, the index for a range — which is
   * documented in the README as this host's rule rather than left implicit.
   */
  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    const body = this.#expression(node.children);
    const [first = "item", second] = node.params;
    const source = node.source;

    /** `by=` as a key expression over the row's own binding names. */
    const keyFrom = (fallback: string): string => {
      if (!node.key) return fallback;
      if (node.key.shape === "string") {
        // `by="id"` names a field of the row, exactly as Marko reads it.
        const field =
          node.key.node?.type === "StringLiteral"
            ? node.key.node.value
            : node.key.code.replace(/^['"]|['"]$/g, "");
        return `${first}.${field}`;
      }
      // Any other `by=` is a function of the row, Marko's own contract.
      return `(${node.key.code})(${[first, second].filter(Boolean).join(", ")})`;
    };

    if (source.kind === "of") {
      // The index parameter is emitted only when the author declared one or
      // the key needs it, so an ordinary `<for|item| of=…>` does not leave an
      // unused binding in the callback.
      const params = second ? `${first}, ${second}` : first;
      const key = keyFrom(first);
      this.#out.push(
        `{[...${source.list.code}].map((${params}) => <Fragment key={${key}}>${body}</Fragment>)}`,
      );
      this.#runtimeImports.add("Fragment");
      return;
    }

    if (source.kind === "in") {
      const value = second ?? "value";
      const key = keyFrom(first);
      this.#out.push(
        `{Object.entries(${source.object.code}).map(([${first}, ${value}]) => <Fragment key={${key}}>${body}</Fragment>)}`,
      );
      this.#runtimeImports.add("Fragment");
      return;
    }

    const from = source.from?.code ?? "0";
    const bound = source.bound.code;
    const step = source.step;
    const counter = hygienicName("mxIndex", node.params, body);
    // The row count, computed the same way for both bound forms: `to=` is
    // inclusive, `until=` is not. `Math.max(0, …)` is what makes a backwards
    // or empty range render nothing rather than throwing on a negative length.
    const span = step
      ? `${source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${source.inclusive ? " + 1" : ""}`
      : `(${bound}) - (${from})${source.inclusive ? " + 1" : ""}`;
    const value = step
      ? `(${from}) + ${counter} * (${step.code})`
      : `(${from}) + ${counter}`;
    // One `.map` over the index array, binding the loop value inside the
    // callback rather than in a first pass. Building the values first and
    // mapping them second (the shape this replaced) put the counter out of
    // scope in the callback, so the default `key` referenced an undefined
    // name — a range loop's rows are keyed by their own value, which the
    // author's param already names.
    const key = keyFrom(first);
    this.#out.push(
      `{Array.from({ length: Math.max(0, ${span}) }, (_, ${counter}) => ${value}).map((${first}) => <Fragment key={${key}}>${body}</Fragment>)}`,
    );
    this.#runtimeImports.add("Fragment");
  }

  /**
   * `<define>` as a local function returning JSX.
   *
   * Unlike Solid's and Astro's hosts, which refuse it because their output is
   * a single expression, a Preact component *is* a function body — so a local
   * block is an ordinary local function and lowers directly. It is emitted
   * into the component's prelude by `emitModule`, not inline, since a function
   * declaration is a statement.
   */
  define(node: Extract<IrNode, { kind: "Define" }>): void {
    fail(
      "`<define>` must appear at the top level of the template; a block declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    fail(
      "`<const>` must appear at the top level of the template; a binding declared inside markup cannot be lifted without changing its scope",
      node,
    );
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail("a hoisted statement cannot be emitted inside a JSX expression", node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const data = node.tag.data as HostTagData;
    if (data.kind !== "try") fail("unknown Preact host-tag lowering", node);

    const catchTag = node.tag.attributeTags.find((tag) => tag.name === "catch");
    const placeholder = node.tag.attributeTags.find(
      (tag) => tag.name === "placeholder",
    );

    let inner = this.#render(node.tag.children);
    if (placeholder) {
      // `<@placeholder>` is what renders while the body is suspended, which on
      // this target means the body threw a promise (a `lazy()` child). Preact
      // gives that through `Suspense`; the package re-exports it under one
      // name so the emitted text is target-independent.
      this.#runtimeImports.add(this.#target.suspenseName);
      const fallback = this.#expression(placeholder.block.children);
      inner = `<${this.#target.suspenseName} fallback={${fallback}}>${inner}</${this.#target.suspenseName}>`;
    }
    if (!catchTag) {
      this.#out.push(inner);
      return;
    }

    // `<@catch|error|>` renders instead of the body when it throws. Preact has
    // no built-in boundary component, only the `componentDidCatch` hook, so
    // the package ships the class that wraps it.
    this.#runtimeImports.add(this.#target.errorBoundaryName);
    const params = catchTag.block.params.join(", ");
    const caught = this.#expression(catchTag.block.children);
    const fallback = catchTag.block.hasParams
      ? `(${params}) => ${caught}`
      : caught;
    this.#out.push(
      `<${this.#target.errorBoundaryName} fallback={${fallback}}>${inner}</${this.#target.errorBoundaryName}>`,
    );
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    fail(
      "a document type (`<!doctype html>`) cannot appear in a Preact component; write it in the HTML shell that mounts the app",
      node,
    );
  }

  comment(_node: Extract<IrNode, { kind: "Comment" }>): void {
    // JSX has no comment node that survives to the DOM, and an author-only
    // `//` comment is not output on any host. Dropping both matches the other
    // hosts' treatment.
  }

  done(): string {
    return this.#out.join("");
  }
}

export function createEmitter(target: Target = preactTarget): PreactEmitter {
  return new PreactEmitter(target);
}

/** Emits the template body of a resolved IR as one JSX expression. */
export function emitPreact(ir: Ir, target: Target = preactTarget): string {
  const emitter = createEmitter(target);
  drive(emitter, ir.body);
  return emitter.done();
}

export type { HostTagData };
