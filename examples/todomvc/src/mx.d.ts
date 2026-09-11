/**
 * Ambient declaration for `.solid.mx` imports.
 *
 * `@mxlang/vite-plugin` turns these into ordinary JSX modules at build time, but
 * `tsc` cannot see through the transform, so every export is typed as a Solid
 * component. `@mxlang/typescript-plugin`'s virtual-`.tsx` projection (spec section
 * 7.2) is what will give these real per-export types; until it ships this is
 * what keeps the example type-checkable.
 */
declare module "*.solid.mx" {
  import type { Component } from "solid-js";

  const exports: Record<string, Component<Record<string, never>>>;
  export default exports;
  export const App: Component<Record<string, never>>;
}
