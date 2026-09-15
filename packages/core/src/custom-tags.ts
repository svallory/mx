/**
 * The host-independent Custom Tag contract.
 *
 * A caller discovers and loads tag definitions before compilation, then hands
 * them to the core as a name-to-definition map. The core owns validation and
 * transformation; hosts receive only ordinary IR and never learn that a
 * custom tag existed.
 */

import type { Ctx, Node } from "./core.ts";
import { TranslateError } from "./core.ts";
import type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  Expr,
  ForSource,
  IrNode,
  Position,
} from "./ir.ts";

export interface CustomTagParseOptions {
  /** Body arrives as one unparsed text node. */
  text?: boolean;
  /** Keep body whitespace. */
  preserveWhitespace?: boolean;
  /** The tag may not have a body. */
  openTagOnly?: boolean;
}

export interface CustomTagAttribute {
  type?: "string" | "number" | "boolean" | "expression";
  required?: boolean;
  enum?: string[];
  default?: unknown;
  /** Reject a runtime expression when the tag needs a literal value. */
  staticOnly?: boolean;
}

export interface CustomTagAttributeTag {
  repeated?: boolean;
  required?: boolean;
}

/** A per-file store. Its runtime implementation arrives in phase 5. */
export interface TagStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface AnalyzeContext {
  store: TagStore;
  fail(message: string, at?: Position): never;
}

export interface FinalizeContext {
  store: TagStore;
  build: IrBuilders;
  gensym(hint?: string): string;
}

/** One call site, with every author-written part already lowered to IR. */
export interface TagCall {
  name: string;
  loc: Position;
  attrs: Attr[];
  content: Block | null;
  attributeTags: AttributeTag[];
  params: string[];
  var: string | null;
}

export interface TransformContext {
  /** Builders that stamp synthetic nodes with the call site's position. */
  build: IrBuilders;
  /** A hygienic, per-file-unique binding name. */
  gensym(hint?: string): string;
  /** Write `throw ctx.fail(...)` so TypeScript narrows the failed branch. */
  fail(message: string, at?: Position): never;
  /** Lifts a statement to the head of the enclosing function. */
  hoist(code: string): void;
  /** Typed now; accessing it fails clearly until phase 5 implements stores. */
  store: TagStore;
}

/** The default export of an `x.tag.ts` sidecar. */
export interface CustomTag {
  parseOptions?: CustomTagParseOptions;
  attributes?: Record<string, CustomTagAttribute>;
  attributeTags?: Record<string, CustomTagAttributeTag>;
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;
  transform?(call: TagCall, ctx: TransformContext): IrNode[];
  finalize?(ctx: FinalizeContext): IrNode[];
}

/** Builders available to a transform. Module-level IR is deliberately absent. */
export interface IrBuilders {
  text(value: string): IrNode;
  interpolation(expr: Expr, escaped?: boolean): IrNode;
  element(
    name: string,
    attrs?: Attr[],
    children?: IrNode[],
    options?: { void?: boolean },
  ): IrNode;
  attr(name: string, value: string): Attr;
  dynamicAttr(name: string, value: Expr): Attr;
  booleanAttr(name: string): Attr;
  expr(code: string): Expr;
  ifChain(
    branches: Array<{ condition: Expr | null; children: IrNode[] }>,
  ): IrNode;
  forLoop(options: {
    source: ForSource;
    params: string[];
    bindings?: string[];
    key?: Expr | null;
    children: IrNode[];
  }): IrNode;
  block(children: IrNode[], params?: string[]): Block;
  /** Requests a primitive from the active host without exposing that host. */
  hostTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
  ): IrNode;
}

export const MAX_EXPANSION_DEPTH = 64;
export const MAX_EXPANSION_NODES = 100_000;

const CUSTOM_TAGLIB_ID = "mx-custom-tags";

function parserTaglibId(
  customTags: Readonly<Record<string, CustomTag>>,
): string {
  // Marko caches injected taglibs by id for the life of the process. Include
  // the complete parser-facing definition in that id so two compilations with
  // different custom tag maps cannot accidentally reuse the first lookup.
  const signature = Object.entries(customTags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => [name, definition.parseOptions ?? null]);
  return `${CUSTOM_TAGLIB_ID}:${JSON.stringify(signature)}`;
}

/**
 * The error a registered name shadowing a core-owned built-in (`<try>`)
 * always throws, wherever it is caught.
 *
 * Two call sites throw it: `customTagTaglib` below (registration-time, before
 * any parsing — the one place both compile entry points, `compile.ts`'s
 * whole-file compile and `fragment.ts`'s `.solid.mx`/TS-plugin path, hand the
 * complete `customTags` map over) and `lowerTag`'s call-site check (which
 * only ever sees a name Marko has already agreed to parse as that tag).
 * Without the registration-time check, a shadowing registration that also
 * set `parseOptions` (e.g. `try: { parseOptions: { openTagOnly: true } }`)
 * changed how the parser itself read `<try>` before lowering ever ran,
 * surfacing as an unrelated parser error instead of this diagnostic.
 */
export function shadowedBuiltinMessage(name: string): string {
  return `\`<${name}>\` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name`;
}

/**
 * Converts registered tags into the parser-only part of a Marko taglib.
 *
 * Hooks and attribute declarations never enter the compiler's taglib: some
 * similarly named Marko keys are executable Babel hooks with incompatible
 * signatures. Only the three approved parser switches cross this boundary.
 */
export function customTagTaglib(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): [string, unknown] | null {
  if (!customTags || Object.keys(customTags).length === 0) return null;

  const definitions: Record<string, unknown> = Object.create(null);
  for (const [name, definition] of Object.entries(customTags)) {
    const configured = definition.parseOptions;
    const parseOptions = configured
      ? {
          ...(configured.text === undefined ? {} : { text: configured.text }),
          ...(configured.preserveWhitespace === undefined
            ? {}
            : { preserveWhitespace: configured.preserveWhitespace }),
          ...(configured.openTagOnly === undefined
            ? {}
            : { openTagOnly: configured.openTagOnly }),
        }
      : undefined;
    definitions[`<${name}>`] = parseOptions ? { parseOptions } : {};
  }
  return [parserTaglibId(customTags), definitions];
}

function syntheticExpr(code: string): Expr {
  return { code, shape: "other", node: null as unknown as Node };
}

function failAt(tagName: string, message: string, at: Position): never {
  throw new TranslateError(`\`<${tagName}>\`: ${message}`, at.line, at.column);
}

function buildersFor(
  loc: Position,
  ctx: Ctx,
  node: Node,
  tagName: string,
): IrBuilders {
  return {
    text: (value) => ({ kind: "Text", value, loc }),
    interpolation: (value, escaped = true) => ({
      kind: "Interpolation",
      expr: value,
      escaped,
      loc,
    }),
    element: (name, attrs = [], children = [], options = {}) => ({
      kind: "Element",
      name,
      attrs,
      children,
      void: options.void ?? false,
      loc,
    }),
    attr: (name, value) => ({
      kind: "static",
      name,
      value,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    dynamicAttr: (name, value) => ({
      kind: "dynamic",
      name,
      value,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    booleanAttr: (name) => ({
      kind: "boolean",
      name,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    expr: syntheticExpr,
    ifChain: (branches) => ({
      kind: "IfChain",
      branches: branches.map((branch): Branch => ({ ...branch, loc })),
      loc,
    }),
    forLoop: (options) => ({
      kind: "For",
      source: options.source,
      params: options.params,
      paramNodes: [],
      bindings: options.bindings ?? options.params,
      key: options.key ?? null,
      children: options.children,
      loc,
    }),
    block: (children, params = []) => ({
      hasParams: params.length > 0,
      params,
      children,
      loc,
    }),
    hostTag: (name, children, attributeTags) => {
      if (ctx.declarations.claimsTag?.(name, ctx) !== true) {
        return failAt(
          tagName,
          `this host does not claim \`<${name}>\`, so a custom tag cannot emit one`,
          loc,
        );
      }
      return {
        kind: "HostTag",
        tag: {
          name,
          attrs: [],
          children,
          attributeTags,
          params: [],
          var: null,
          data: ctx.declarations.resolveHostTag?.(name, node, ctx),
          loc,
        },
        loc,
      };
    },
  };
}

interface LiteralValue {
  type: "string" | "number" | "boolean";
  value: string | number | boolean;
}

function listEnum(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function literalValue(attr: Attr): LiteralValue | null {
  if (attr.kind === "static") return { type: "string", value: attr.value };
  if (attr.kind === "boolean") return { type: "boolean", value: true };
  if (attr.kind !== "dynamic") return null;

  switch (attr.value.node?.type) {
    case "StringLiteral":
      return { type: "string", value: attr.value.node.value };
    case "NumericLiteral":
      return { type: "number", value: attr.value.node.value };
    case "BooleanLiteral":
      return { type: "boolean", value: attr.value.node.value };
    default:
      return null;
  }
}

/**
 * Materializes a declared `default` as the attribute the call omitted.
 *
 * A default is applied after validation, so a call that supplies the attribute
 * is checked on its own value and a default is never re-checked against the
 * declaration that produced it. Only a literal default can become an `Attr`:
 * the attribute a transform reads has to be indistinguishable from one the
 * author wrote, which means carrying a real literal node so `literalValue`
 * reads the same type back. A non-literal default has no such spelling and is
 * a definition error rather than something silently dropped.
 */
function defaultAttr(
  tagName: string,
  name: string,
  value: unknown,
  loc: Position,
): Attr {
  const nameSpan = { sourceStart: 0, sourceEnd: 0 };
  if (typeof value === "string") {
    return { kind: "static", name, value, nameSpan, loc };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const code = String(value);
    const node = {
      type: typeof value === "number" ? "NumericLiteral" : "BooleanLiteral",
      value,
    } as unknown as Node;
    return {
      kind: "dynamic",
      name,
      value: { code, shape: "other", node },
      nameSpan,
      loc,
    };
  }
  return failAt(
    tagName,
    `attribute \`${name}\` declares a \`default\` that is not a string, number or boolean, so it has no attribute spelling`,
    loc,
  );
}

/**
 * Returns `call.attrs` with every omitted, defaulted attribute appended.
 *
 * Returns the original array when nothing is defaulted, so the common case
 * allocates nothing and author order is untouched.
 */
export function applyCustomTagDefaults(
  definition: CustomTag,
  call: TagCall,
): Attr[] {
  const attributes = definition.attributes;
  if (!attributes) return call.attrs;

  const present = new Set<string>();
  for (const attr of call.attrs) {
    if (attr.kind !== "spread") present.add(attr.name);
  }

  const defaulted: Attr[] = [];
  for (const [name, declaration] of Object.entries(attributes)) {
    if (declaration.default === undefined || present.has(name)) continue;
    defaulted.push(defaultAttr(call.name, name, declaration.default, call.loc));
  }
  return defaulted.length === 0 ? call.attrs : [...call.attrs, ...defaulted];
}

/** Enforces a tag's closed attribute contract before its transform runs. */
export function validateCustomTagCall(
  definition: CustomTag,
  call: TagCall,
): void {
  const attributes = definition.attributes;
  if (attributes) {
    // A tag declaring no attributes at all (`attributes: {}`) rejects a
    // spread the same way it rejects a named one: "cannot be checked" is
    // true of every declaration, so it describes the checker rather than the
    // author's actual mistake — writing an attribute where the tag accepts
    // none.
    const acceptsNone = Object.keys(attributes).length === 0;
    const present = new Set<string>();
    for (const attr of call.attrs) {
      if (attr.kind === "spread") {
        failAt(
          call.name,
          acceptsNone
            ? "accepts no attributes"
            : "spread attributes cannot be checked against this tag's declared attributes",
          attr.loc,
        );
      }
      const declaration = Object.hasOwn(attributes, attr.name)
        ? attributes[attr.name]
        : undefined;
      if (!declaration) {
        failAt(
          call.name,
          acceptsNone
            ? "accepts no attributes"
            : `unknown attribute \`${attr.name}\``,
          attr.loc,
        );
      }
      present.add(attr.name);

      const literal = literalValue(attr);
      if (declaration.staticOnly && !literal) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be a static literal`,
          attr.loc,
        );
      }
      if (
        declaration.type &&
        declaration.type !== "expression" &&
        literal &&
        declaration.type !== literal.type
      ) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be ${declaration.type}, got ${literal.type}`,
          attr.loc,
        );
      }
      if (
        declaration.type === "expression" &&
        (attr.kind === "static" || attr.kind === "boolean")
      ) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be an expression`,
          attr.loc,
        );
      }
      if (declaration.enum) {
        if (!literal) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be a static value from ${listEnum(declaration.enum)}`,
            attr.loc,
          );
        }
        // `enum` is `string[]`, so only a string literal can be a member.
        // Comparing through `String()` would let `<t mode/>` (boolean `true`)
        // satisfy `enum: ["true"]` and `mode=24` satisfy `enum: ["24"]`; the
        // declared `type` is the value's real type, so require it to match.
        const enumType = declaration.type ?? "string";
        if (
          enumType !== "string" ||
          literal.type !== "string" ||
          typeof literal.value !== "string"
        ) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be a string from ${listEnum(declaration.enum)}, got ${literal.type}`,
            attr.loc,
          );
        }
        if (!declaration.enum.includes(literal.value)) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be one of ${listEnum(declaration.enum)}, got ${JSON.stringify(literal.value)}`,
            attr.loc,
          );
        }
      }
    }

    for (const [name, declaration] of Object.entries(attributes)) {
      if (declaration.required && !present.has(name)) {
        failAt(call.name, `missing required attribute \`${name}\``, call.loc);
      }
    }
  }

  const declaredTags = definition.attributeTags;
  if (!declaredTags) return;

  const seen = new Map<string, AttributeTag>();
  for (const tag of call.attributeTags) {
    const declaration = Object.hasOwn(declaredTags, tag.name)
      ? declaredTags[tag.name]
      : undefined;
    if (!declaration) {
      failAt(call.name, `unknown attribute tag \`<@${tag.name}>\``, tag.loc);
    }
    if (seen.has(tag.name) && declaration.repeated !== true) {
      failAt(
        call.name,
        `attribute tag \`<@${tag.name}>\` may not be repeated`,
        tag.loc,
      );
    }
    seen.set(tag.name, tag);
  }
  for (const [name, declaration] of Object.entries(declaredTags)) {
    if (declaration.required && !seen.has(name)) {
      failAt(
        call.name,
        `missing required attribute tag \`<@${name}>\``,
        call.loc,
      );
    }
  }
}

function countNodes(nodes: IrNode[]): number {
  let total = 0;
  const pending = [...nodes];
  const enqueue = (children: IrNode[]) => {
    for (const child of children) pending.push(child);
  };
  for (let node = pending.pop(); node; node = pending.pop()) {
    total++;
    if (total > MAX_EXPANSION_NODES) return total;
    if ("children" in node && Array.isArray(node.children)) {
      enqueue(node.children as IrNode[]);
    }
    if (node.kind === "IfChain") {
      for (const branch of node.branches) enqueue(branch.children);
    }
    if (node.kind === "Component") {
      if (node.content) enqueue(node.content.children);
      for (const tag of node.attributeTags) {
        enqueue(tag.block.children);
      }
    }
    if (node.kind === "HostTag") {
      enqueue(node.tag.children);
      for (const tag of node.tag.attributeTags) {
        enqueue(tag.block.children);
      }
    }
  }
  return total;
}

function observedCall(call: TagCall): {
  call: TagCall;
  attributeTagsRead(): boolean;
} {
  let read = false;
  return {
    call: new Proxy(call, {
      get(target, property, receiver) {
        if (property === "attributeTags") read = true;
        return Reflect.get(target, property, receiver);
      },
    }),
    attributeTagsRead: () => read,
  };
}

/** Runs a validated transform and normalizes its failures to TranslateError. */
export function transformCustomTag(
  ctx: Ctx,
  definition: CustomTag,
  call: TagCall,
  node: Node,
): IrNode[] {
  if (definition.analyze || definition.finalize) {
    const hooks = [
      ...(definition.analyze ? ["analyze"] : []),
      ...(definition.finalize ? ["finalize"] : []),
    ];
    failAt(
      call.name,
      `${hooks.join("/")} custom tag hooks are not implemented until P5`,
      call.loc,
    );
  }
  if (!definition.transform) {
    failAt(
      call.name,
      "custom tag has no transform; template expansion is not implemented until P3",
      call.loc,
    );
  }

  validateCustomTagCall(definition, call);
  const withDefaults: TagCall = {
    ...call,
    attrs: applyCustomTagDefaults(definition, call),
  };
  const observed = observedCall(withDefaults);
  const builders = buildersFor(call.loc, ctx, node, call.name);
  const tagContext: TransformContext = {
    build: builders,
    hoist: (code) => ctx.hoist(code, node),
    fail: (message, at) => failAt(call.name, message, at ?? call.loc),
    gensym: (hint) => {
      ctx.customTagGensym = (ctx.customTagGensym ?? 0) + 1;
      const serial = ctx.customTagGensym;
      const safeTag = call.name.replace(/[^A-Za-z0-9_]/g, "_");
      const safeHint = (hint ?? "t").replace(/[^A-Za-z0-9_]/g, "_");
      return `$mx_${safeTag}_${safeHint}${serial}`;
    },
    get store(): TagStore {
      return failAt(
        call.name,
        "ctx.store is not implemented until P5",
        call.loc,
      );
    },
  };

  let nodes: IrNode[];
  try {
    nodes = definition.transform(observed.call, tagContext);
  } catch (error) {
    if (error instanceof TranslateError) throw error;
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag threw: ${error instanceof Error ? error.message : String(error)}`,
      call.loc.line,
      call.loc.column,
    );
  }

  if (!Array.isArray(nodes)) {
    failAt(call.name, "custom tag must return an array of IR nodes", call.loc);
  }
  const total = countNodes(nodes);
  if (total > MAX_EXPANSION_NODES) {
    failAt(
      call.name,
      `custom tag expansion produced ${total} nodes, over the ${MAX_EXPANSION_NODES} limit`,
      call.loc,
    );
  }
  if (call.attributeTags.length > 0 && !observed.attributeTagsRead()) {
    console.warn(
      `\`<${call.name}>\` at ${call.loc.line}:${call.loc.column}: custom tag transform did not read its attributeTags; authored attribute tags were dropped`,
    );
  }
  return nodes;
}
