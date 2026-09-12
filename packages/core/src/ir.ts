/**
 * MX's host-independent intermediate representation (decision 79).
 *
 * The core parses a Marko template, validates it against a host's
 * declarations, and resolves the structural subset into the tree defined
 * here. A **host** then walks this tree and emits: the vanilla host prints a
 * string builder, Astro prints ternaries and `.map`, Solid prints
 * `<Show>`/`<For>`. None of them looks at a Marko node.
 *
 * ## Why an IR is possible here and not in Marko
 *
 * The constructs with compile-time semantics are *closed* in MX 1: the
 * structural core (`<if>`, `<for>`, `<define>`, `<const>`, statement tags)
 * plus "component call", where every user tag lowers the same way and
 * stateful tags are host hooks rather than user taglib hooks. Marko's own
 * taglibs let any tag define its own `analyze`/`translate`, so no fixed node
 * set could describe a Marko program. Decision 79's consequence for MX 2:
 * user-level compile hooks would need an opaque node every host must handle,
 * so that door stays shut.
 *
 * ## Positions
 *
 * Every node carries `loc`, in the shape `TranslateError` reports (1-based
 * line, 0-based column). Marko's own nodes carry no numeric offsets at all,
 * only `loc.{line,column}`, so that is what the IR can carry — see
 * `fragment.ts` for the measured limits.
 *
 * ## Expressions
 *
 * An expression appears as `Expr`: its source text, parsed shape, and the
 * Marko/Babel node it came from. The resolver computes the shape once so an
 * emitter never has to inspect that parser node to distinguish an object,
 * array, string, or other expression. The text is what every host ultimately
 * emits, and printing it once during resolve keeps hosts from each reaching
 * for a Babel generator.
 */

import type { Node } from "./core.ts";

/** A source position, as Marko reports one and `TranslateError` carries it. */
export interface Position {
  /** 1-based, as Marko and `TranslateError` both count lines. */
  line: number;
  /** 0-based, as Marko and `TranslateError` both count columns. */
  column: number;
}

/**
 * An expression, as both the parsed node and its printed source.
 *
 * `code` has already been through the binding registry's reference rewriting
 * (decision 70's third hook), so a host emits it verbatim rather than
 * re-deriving it. `node` is the original, for a host that must inspect the
 * shape — `class={a: true}` versus `class=someCall()` is an
 * `ObjectExpression` test, not a string test.
 */
export interface Expr {
  code: string;
  shape: ExprShape;
  node: Node;
}

/** The syntax-level value shape known while resolving an expression. */
export type ExprShape = "object" | "array" | "string" | "other";

/** Common to every IR node. */
export interface IrBase {
  loc: Position;
}

/**
 * One attribute on an element or a component call.
 *
 * `kind` separates the three shapes a host emits differently: a value known at
 * compile time (bakeable into a literal), one that is not, and a spread whose
 * keys are only known at run time.
 */
export type Attr =
  | ({ kind: "static"; name: string; value: string } & IrBase)
  /** A bare attribute (`disabled`), HTML's spelling of `true`. */
  | ({ kind: "boolean"; name: string } & IrBase)
  | ({ kind: "dynamic"; name: string; value: Expr } & IrBase)
  /**
   * `value:=expr`, Marko's two-way binding. Resolved rather than rejected: a
   * host with no update path emits the initial value, which is what Marko's
   * own server render does.
   */
  | ({ kind: "bound"; name: string; value: Expr } & IrBase)
  | ({ kind: "spread"; value: Expr } & IrBase);

/**
 * A block of children a host emits as a callable unit: an attribute tag's
 * body, or a component's ordinary children.
 *
 * `params` are the tag params the block declares (`<@footer|year|>`), as
 * source text. A host that has no render-prop form rejects a non-empty
 * `params` itself — the core resolves the shape rather than deciding whether
 * the target can express it.
 */
export interface Block extends IrBase {
  /** Distinguishes `<Tag||>` from a tag with no parameter pipes. */
  hasParams: boolean;
  params: string[];
  children: IrNode[];
}

/** What a `<for>` iterates, normalized to the three forms a host emits. */
export type ForSource =
  | { kind: "of"; list: Expr }
  | { kind: "in"; object: Expr }
  /**
   * `from`/`to`/`until`. `inclusive` distinguishes `to=` (`<=`) from `until=`
   * (`<`); `from` defaults to a literal `0` when the author omitted it.
   * `step` is the increment per iteration; absent when the author omitted it,
   * and the host decides the default (1 for HTML's runtime loop, a `step`
   * prop for Solid's `<Repeat>`).
   */
  | {
      kind: "range";
      from: Expr | null;
      bound: Expr;
      inclusive: boolean;
      step: Expr | null;
    };

/** One branch of an if-chain: a condition and its children. */
export interface Branch extends IrBase {
  /** `null` for the trailing `<else>`. */
  condition: Expr | null;
  children: IrNode[];
}

/**
 * A tag the core does not own, handed to the host with its parts resolved.
 *
 * The escape hatch decision 79 keeps deliberately narrow: the *core's*
 * structural tags are real IR kinds, and everything a host defines for itself
 * (`<try>`, `<html-comment>`, a `server` block, a future `<signal>`) arrives
 * here with its name, attributes, children and attribute tags already
 * resolved, so the host emits rather than re-parses. `node` is the original
 * Marko node, for a host that needs a field the IR does not model.
 */
export interface HostTag<Data = unknown> extends IrBase {
  name: string;
  attrs: Attr[];
  children: IrNode[];
  attributeTags: AttributeTag[];
  params: string[];
  /** The tag's `/var` binding, as source text, when it declares one. */
  var: string | null;
  /**
   * Whatever the host decided about this tag at *resolve* time, from its
   * `resolveHostTag` hook.
   *
   * The point of the slot is that a host records its decision once, while the
   * Marko node is still in hand, instead of re-deriving it at emit time — an
   * emitter that had to re-inspect `node` would be walking Marko nodes again,
   * which is the thing the IR exists to stop. `undefined` when the host
   * supplies no hook.
   *
   * This is also the seam decision 80's user-tag macros will need: a
   * user-defined tag that carries compile-time meaning has to hand its
   * resolved form to every host through exactly this channel, since the core
   * cannot know what the macro decided. The original Marko node is deliberately
   * absent: emission must consume the IR and `data`, never re-walk parser nodes.
   */
  data: Data;
}

/** `<@name>body</@name>` — a prop of the component call it sits inside. */
export interface AttributeTag extends IrBase {
  name: string;
  block: Block;
}

/** What a component call resolves its target to. */
export type ComponentTarget =
  /** An `import` binding or a taglib/`tags/`-discovered tag, by name. */
  | { kind: "name"; name: string }
  /** A `<define>` in scope, with the parameter names it declared. */
  | { kind: "define"; name: string; params: string[] }
  /** `<${expr}/>`, resolved at run time by the host. */
  | { kind: "dynamic"; expr: Expr };

export type IrNode =
  /** A literal run of text. Already normalized by Marko's own `onText`. */
  | ({ kind: "Text"; value: string } & IrBase)
  /** `${expr}` / `$!{expr}`; `escaped` is false for the raw form. */
  | ({ kind: "Interpolation"; expr: Expr; escaped: boolean } & IrBase)
  | ({
      kind: "Element";
      name: string;
      attrs: Attr[];
      children: IrNode[];
      /** True for `<br>` and friends: no children, no closing tag. */
      void: boolean;
    } & IrBase)
  | ({
      kind: "Component";
      target: ComponentTarget;
      attrs: Attr[];
      /** Ordinary children, or null when the call has no content. */
      content: Block | null;
      attributeTags: AttributeTag[];
      /** Tag arguments, `<Row(a, b)/>`, for a positional `<define>` call. */
      args: Expr[];
    } & IrBase)
  | ({ kind: "IfChain"; branches: Branch[] } & IrBase)
  | ({
      kind: "For";
      source: ForSource;
      /** The tag params, as source text; at least one, enforced at resolve. */
      params: string[];
      /** Every name the params bind, for a host that tracks scopes. */
      bindings: string[];
      /**
       * The `by=` expression, as resolved source. `null` when the author
       * omitted it. A string-emitting host ignores it (no reconciliation in a
       * one-shot render, decision 65); a reactive host emits it as the
       * `keyed` prop on `<For>`.
       */
      key: Expr | null;
      children: IrNode[];
    } & IrBase)
  | ({
      kind: "Define";
      name: string;
      params: string[];
      children: IrNode[];
    } & IrBase)
  | ({ kind: "Const"; name: string; init: Expr } & IrBase)
  /** A `static` block, or a host statement block that hoists like one. */
  | ({ kind: "Static"; code: string; end: Position } & IrBase)
  | ({
      kind: "Import";
      code: string;
      bindings: string[];
      end: Position;
    } & IrBase)
  /** Any other top-level `export`, hoisted verbatim to module scope. */
  | ({ kind: "Export"; code: string; end: Position } & IrBase)
  /** `export interface Input`, lifted so a host can place it. */
  | ({ kind: "InputInterface"; code: string; end: Position } & IrBase)
  /** A statement lifted by decision 70's `hoist` hook. */
  | ({ kind: "Hoisted"; code: string; end: Position } & IrBase)
  | ({ kind: "HostTag"; tag: HostTag<unknown> } & IrBase)
  /** `<!doctype html>`; `value` has its delimiters stripped by Marko. */
  | ({ kind: "DocumentType"; value: string } & IrBase)
  /**
   * A comment. `html` distinguishes `<!-- -->` from a `//` line comment —
   * Marko strips the delimiters, so only the source can tell them apart.
   */
  | ({ kind: "Comment"; value: string; html: boolean } & IrBase);

/** The resolved template: its module-level parts, and its body. */
export interface Ir {
  /** `import` statements, hoisted to module scope in source order. */
  imports: Array<Extract<IrNode, { kind: "Import" }>>;
  /** `static`/`server` block statements, hoisted to module scope. */
  hoisted: Array<Extract<IrNode, { kind: "Static" | "Export" }>>;
  /** The author's `export interface Input`, or null. */
  inputInterface: Extract<IrNode, { kind: "InputInterface" }> | null;
  /** Statements lifted to the render function's head by the hoist hook. */
  prelude: Array<Extract<IrNode, { kind: "Hoisted" }>>;
  /** The template body. */
  body: IrNode[];
}
