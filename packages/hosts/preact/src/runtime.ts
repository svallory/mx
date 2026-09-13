/**
 * The one runtime this host ships: `<try>`'s error boundary and placeholder.
 *
 * Decision 82 says MX itself ships no runtime, and this does not contradict
 * it: nothing here is an MX runtime, it is *Preact* code an MX author would
 * otherwise have to write by hand, shipped so the `<try>` lowering has a
 * component to name. A template that never writes `<try>` imports none of it,
 * because the emitter only emits the import when it emits the lowering.
 *
 * ## Why a class component
 *
 * Preact has no built-in error boundary component. It does have the hook —
 * `componentDidCatch` on a class component is Preact's own supported way to
 * catch a render error in a subtree, the same contract React documents — but
 * no component wrapping it. `preact/compat`'s `Suspense` catches thrown
 * *promises* (that is what makes `lazy()` work) and not thrown errors, so it
 * covers `<@placeholder>` and not `<@catch>`. So this file ships both:
 *
 * - `MxErrorBoundary` — `componentDidCatch`, for `<@catch>`. A class, because
 *   that is the only form Preact gives the hook; there is no hook-based
 *   equivalent in Preact 10.
 * - `MxPlaceholder` — a thin alias of `preact/compat`'s `Suspense`, for
 *   `<@placeholder>`. Aliased rather than re-implemented so a body that
 *   suspends (a `lazy()` child, a thrown promise) behaves exactly as Preact
 *   documents, and so the emitter names one thing whichever target it is on.
 *
 * Both are ordinary Preact components with no MX-specific protocol, so a
 * consumer can use them directly or replace them with their own.
 */

import {
  Component,
  type ComponentChildren,
  createElement,
  type VNode,
} from "preact";
import { Suspense } from "preact/compat";

/**
 * Marko's structured `class` value, joined into the string Preact's `class`
 * prop takes.
 *
 * Marko accepts `class={a: true, b: false}` and `class=["x", {y: cond}]` and
 * renders the enabled names; Preact's `class` takes a string (or an object
 * only via third-party helpers, which this host does not require). Handing the
 * raw object through would render `[object Object]` — a silently wrong
 * attribute rather than a visible failure — so the emitter routes a structured
 * value through here.
 *
 * The rules are Marko's own: a string contributes itself, an array flattens
 * recursively, an object contributes each key whose value is truthy, and
 * `null`/`undefined`/`false` contribute nothing.
 */
export function mxClass(value: unknown): string {
  const parts: string[] = [];
  const walk = (item: unknown): void => {
    if (item === null || item === undefined || item === false) return;
    if (typeof item === "string") {
      if (item !== "") parts.push(item);
      return;
    }
    if (typeof item === "number") {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
      return;
    }
    if (typeof item === "object") {
      for (const [key, enabled] of Object.entries(item)) {
        if (enabled) parts.push(key);
      }
    }
  };
  walk(value);
  return parts.join(" ");
}

export interface MxErrorBoundaryProps {
  /**
   * Rendered instead of the children when the subtree throws.
   *
   * A function so `<@catch|error|>` can name the error — MX's own attribute
   * tag declares the param, and this is what receives it. A plain node is
   * accepted too, for `<@catch>` with no params.
   */
  fallback: ComponentChildren | ((error: unknown) => ComponentChildren);
  children?: ComponentChildren;
}

interface MxErrorBoundaryState {
  error: unknown;
  caught: boolean;
}

/**
 * Renders `fallback` when its subtree throws during render.
 *
 * `caught` is tracked separately from `error` because a subtree may throw a
 * falsy value (`throw undefined` is legal JavaScript, and a rejected promise
 * can carry one); keying off `error` alone would re-render the failed subtree
 * forever in that case.
 */
export class MxErrorBoundary extends Component<
  MxErrorBoundaryProps,
  MxErrorBoundaryState
> {
  state: MxErrorBoundaryState = { error: undefined, caught: false };

  static getDerivedStateFromError(error: unknown): MxErrorBoundaryState {
    return { error, caught: true };
  }

  componentDidCatch(error: unknown): void {
    this.setState({ error, caught: true });
  }

  render(): ComponentChildren {
    if (!this.state.caught) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function"
      ? (fallback as (error: unknown) => ComponentChildren)(this.state.error)
      : fallback;
  }
}

export interface MxPlaceholderProps {
  /** Rendered while the subtree is suspended. */
  fallback: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Renders `fallback` while its subtree is suspended.
 *
 * `preact/compat`'s `Suspense` under this package's own name, so the emitted
 * lowering imports one module and the same JSX text works on a React target
 * that maps the name to `react`'s `Suspense`.
 */
export function MxPlaceholder(props: MxPlaceholderProps): VNode {
  // `createElement` rather than JSX: this file is `.ts`, so that the package
  // needs no JSX build configuration of its own to ship two components.
  return createElement(
    Suspense,
    { fallback: props.fallback },
    props.children,
  ) as VNode;
}
