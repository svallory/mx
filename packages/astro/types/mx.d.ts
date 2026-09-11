/**
 * Ambient typing for `import Card from "../components/card.mx"` inside an
 * `.astro` file (or any `.ts` in an Astro project).
 *
 * A user opts in from their own `src/env.d.ts`:
 *
 * ```ts
 * /// <reference types="@mxlang/astro/types" />
 * ```
 *
 * `any` rather than each file's real `Input` interface, exactly as
 * `@mxlang/translator`'s own `types/marko.d.ts` does it (decision 62's
 * precedent: an ambient `any` until the language service exists). Per-file
 * typing needs a virtual-file projection of the compiled module inside
 * tsserver's language-service layer — the `astro-ts-plugin` task, not
 * something an ambient wildcard declaration can derive. `@astrojs/ts-plugin`
 * is not reusable for it: it adds `.astro` imports *within* `.ts` files, the
 * opposite direction from typing `.mx` imports inside `.astro`.
 */
declare module "*.mx" {
  const render: (input: unknown) => string;
  export default render;
}

/**
 * `.mx` is the official extension (decision 72); `.marko` is the accepted
 * alias, identical treatment. Same shape, same reason.
 */
declare module "*.marko" {
  const render: (input: unknown) => string;
  export default render;
}
