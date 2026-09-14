/**
 * Custom Tags (decision 85, experiment `custom-tags-check`).
 *
 * A custom tag is a user-authored compile-time tag: a module exporting a
 * function that takes the resolved call and returns **IR**, expanded inside
 * `resolve()` before any emitter runs. Hosts never learn the tag exists, so
 * one implementation works on every host — decision 80's central claim, and
 * the thing this file exists to test.
 *
 * ## What is in the core and what is not
 *
 * The core owns the *contract* (the two shapes below), the *expansion point*
 * (one branch in `resolveTag`, taken only for a name the caller registered),
 * and the *limits* (depth and node caps). It owns none of the discovery or
 * loading: `compileSource` receives an already-built
 * `Record<tagName, CustomTagDefinition>` from its caller.
 *
 * That split is deliberate and not an experiment shortcut. `compileSource`
 * runs inside `@marko/compiler`'s synchronous `compileSync`, so loading a
 * module here would mean `require()` on TypeScript source — a hazard this
 * repo has already been bitten by twice (see `@mxlang/vite-plugin`'s
 * `compileMarko`). Each integration (Vite, Bun, `mx-tsc`, the language
 * server) owns a module graph and resolves ahead of time.
 *
 * **What the experiment does:** the fixture runner builds the map by hand
 * from the `.tag.ts` modules it knows about and passes it in.
 *
 * **What a real implementation must do:** in each integration, read the
 * template's `import` statements, resolve each specifier matching the custom
 * tag convention (`*.tag.ts`) through that integration's own resolver, load
 * it (async is fine there — it happens before `compileSource` is called),
 * verify the marker export, and pass the resulting map down. The language
 * server additionally needs an mtime cache and a path for a tag module that
 * itself fails to compile, reported as a diagnostic on the `import` line.
 *
 * ## Positions
 *
 * Two rules, both forced by `fragment.ts`'s measured fact that Marko's nodes
 * carry no numeric offsets:
 *
 * 1. **Author-written material keeps its real position.** Attributes, the
 *    body block and attribute tags arrive already resolved, carrying their own
 *    `loc` and (for an `Expr`) the original Babel node. A custom tag that
 *    relocates them into its output preserves diagnostics for free.
 * 2. **Synthetic material takes the call site's position.** `ctx.build.*`
 *    stamps it, which is why builders exist rather than object literals: a
 *    node with a missing `loc` puts a diagnostic on the wrong line.
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

/**
 * One call site, with every part already resolved to IR.
 *
 * No Marko node is reachable from here, by the same rule `HostTag` follows: a
 * custom tag that could reach the parser node could reach `ctx.lookup` and the
 * whole `@marko/compiler` surface, and the contract would stop being "IR in,
 * IR out".
 */
export interface CustomTagCall {
  /** The tag name as written, for diagnostics. */
  name: string;
  /** The call site. The default position for every synthetic node. */
  loc: Position;
  /** Resolved attributes, in source order. */
  attrs: Attr[];
  /** Ordinary children; `null` when the call has no body. */
  content: Block | null;
  /** `<@name>` children. Repeated names stay repeated entries, as Marko does. */
  attributeTags: AttributeTag[];
  /** Tag params (`<table-of|row|>` gives `["row"]`), as source text. */
  params: string[];
  /** The `/var` binding as source text, when the call declares one. */
  var: string | null;
}

/**
 * What a custom tag may do besides return nodes.
 *
 * Deliberately small. There is no `bindings.register` (an author-visible name
 * introduced by a tag needs a scoped binding registry, and this one is flat),
 * and no module-scope hoist (it would need cross-call dedup and an ordering
 * rule).
 */
export interface CustomTagContext {
  /** Lifts a statement to the head of the enclosing function. */
  hoist(code: string): void;
  /**
   * Fails at the call site, or at a narrower position the tag supplies.
   *
   * **Write it as `throw ctx.fail(…)`.** Measured while writing the `<icon>`
   * tag, and TypeScript's rule rather than MX's: a bare `ctx.fail(…)` does
   * not narrow the branch, because narrowing on a `never`-returning call
   * needs the callee to be a const reference, and `ctx` is a parameter. So
   * `if (!attr) ctx.fail(…)` leaves `attr` possibly undefined on the next
   * line, while `if (!attr) throw ctx.fail(…)` narrows correctly. The real
   * feature must say this in its authoring docs — it is the first thing every
   * tag author hits, and getting it wrong is a type error, not a silent bug.
   */
  fail: (message: string, at?: Position) => never;
  /** Builders that stamp the call site's position on synthetic nodes. */
  build: IrBuilders;
  /** A name no template can see: `$mx_<tag>_<n>`. */
  gensym(hint?: string): string;
}

/** The hook itself. See `NAMING.md` in the report for the naming proposal. */
export type CustomTagExpand = (
  call: CustomTagCall,
  ctx: CustomTagContext,
) => IrNode[];

export interface CustomTagDefinition {
  expand: CustomTagExpand;
}

/** The marker a real implementation checks after loading a tag module. */
export const CUSTOM_TAG = Symbol.for("mx.customTag");

/**
 * Builders stamping the call site's `loc` on every node they make.
 *
 * The markup and structural kinds, plus one escape hatch: `hostTag`, which
 * asks the *host* for a target primitive rather than letting a tag forge one.
 * Absent: the module-level kinds (`Import`, `Static`, `Export`,
 * `InputInterface`), which `resolve()` lifts out of the body and a nested
 * expansion has no business adding — a tag that wants a module-scope import
 * is §5.3's rejected case.
 */
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
  /**
   * A `HostTag` the host already claims — the one escape hatch to a target
   * primitive (investigation §6 case 2: the tag says *what*, the host *how*).
   *
   * The core fills `data` by calling the host's own `resolveHostTag` with the
   * custom tag's original Marko node, so each host's real validation runs and
   * no tag has to know a host's private `data` shape. A host that does not
   * claim the name fails with its own diagnostic, which is correct: `<try>`
   * on `@mxlang/astro` is an error there today too.
   *
   * Measured on all six hosts (`fixtures-custom-tags/try/probe.ts`): a
   * `<boundary>` custom tag emitting `hostTag("try", …)` produces output
   * **byte-identical** to a hand-written `<try>` on every one of them — which
   * overturns the investigation's own §8.4 prediction that `<try>` could not
   * be a custom tag. What made it work is that the host validates the
   * *author's* node, which for this shape (a body plus `<@catch>`/
   * `<@placeholder>`) is the one `<try>` expects; a tag wanting a different
   * call shape from the one the host validates is the remaining open case.
   */
  hostTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
  ): IrNode;
}

/** Limits. A tag calling its own `expand` can diverge; a growing array can too. */
export const MAX_EXPANSION_DEPTH = 64;
export const MAX_EXPANSION_NODES = 100_000;

/**
 * A synthetic `Expr`.
 *
 * `node` is `null` rather than a forged Babel node: nothing downstream may
 * pretend synthetic code has a source position inside itself, and the emitters
 * only read `code` and `shape` for a non-object/array value. A host that does
 * inspect `node` (the `class={a: true}` shape test) gets `shape` instead,
 * which is exactly what that test was factored out into.
 */
function syntheticExpr(code: string): Expr {
  return { code, shape: "other", node: null as unknown as Node };
}

function buildersFor(
  loc: Position,
  ctx: Ctx,
  node: Node,
  tagName: string,
): IrBuilders {
  return {
    text: (value) => ({ kind: "Text", value, loc }),
    interpolation: (expr, escaped = true) => ({
      kind: "Interpolation",
      expr,
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
      branches: branches.map(
        (branch): Branch => ({
          condition: branch.condition,
          children: branch.children,
          loc,
        }),
      ),
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
    hostTag: (name, children, attributeTags) => {
      if (ctx.declarations.claimsTag?.(name, ctx) !== true) {
        throw new TranslateError(
          `\`<${tagName}>\`: this host does not claim \`<${name}>\`, so a custom tag cannot emit one`,
          loc.line,
          loc.column,
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
    block: (children, params = []) => ({
      hasParams: params.length > 0,
      params,
      children,
      loc,
    }),
  };
}

/** Counts nodes in an expansion, for the total-node cap. */
function countNodes(nodes: IrNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total++;
    const children =
      "children" in node && Array.isArray(node.children) ? node.children : [];
    total += countNodes(children as IrNode[]);
    if (node.kind === "IfChain") {
      for (const branch of node.branches) total += countNodes(branch.children);
    }
    if (node.kind === "Component") {
      if (node.content) total += countNodes(node.content.children);
      for (const tag of node.attributeTags) {
        total += countNodes(tag.block.children);
      }
    }
  }
  return total;
}

/**
 * Runs one custom tag's expansion, with the limits and error wrapping.
 *
 * Called from `resolveTag` for a name the caller registered. An unexpected
 * throw from inside a tag is wrapped as a `TranslateError` at the call site
 * with the tag's name first, so a user can tell a tag's bug from an MX bug and
 * the language server's existing diagnostic path reports it unchanged.
 */
export function expandCustomTag(
  ctx: Ctx,
  definition: CustomTagDefinition,
  call: CustomTagCall,
  node: Node,
): IrNode[] {
  const depth = (ctx.customTagDepth ?? 0) + 1;
  if (depth > MAX_EXPANSION_DEPTH) {
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag expansion exceeded ${MAX_EXPANSION_DEPTH} nested invocations`,
      call.loc.line,
      call.loc.column,
    );
  }

  let counter = 0;
  const tagContext: CustomTagContext = {
    hoist: (code) => ctx.hoist(code, node),
    fail: (message, at) => {
      const where = at ?? call.loc;
      throw new TranslateError(
        `\`<${call.name}>\`: ${message}`,
        where.line,
        where.column,
      );
    },
    build: buildersFor(call.loc, ctx, node, call.name),
    gensym: (hint) =>
      `$mx_${call.name.replace(/[^A-Za-z0-9_]/g, "_")}_${hint ?? "t"}${++counter}`,
  };

  ctx.customTagDepth = depth;
  let nodes: IrNode[];
  try {
    nodes = definition.expand(call, tagContext);
  } catch (error) {
    // A `TranslateError` is the tag's own diagnostic (via `ctx.fail`) or one
    // raised while resolving its input; it already carries a position and a
    // message, so it passes through untouched. Anything else is a bug in the
    // tag, and reporting it as a crash would lose the call site entirely.
    if (error instanceof TranslateError) throw error;
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag threw: ${error instanceof Error ? error.message : String(error)}`,
      call.loc.line,
      call.loc.column,
    );
  } finally {
    ctx.customTagDepth = depth - 1;
  }

  if (!Array.isArray(nodes)) {
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag must return an array of IR nodes`,
      call.loc.line,
      call.loc.column,
    );
  }
  const total = countNodes(nodes);
  if (total > MAX_EXPANSION_NODES) {
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag expansion produced ${total} nodes, over the ${MAX_EXPANSION_NODES} limit`,
      call.loc.line,
      call.loc.column,
    );
  }
  return nodes;
}
