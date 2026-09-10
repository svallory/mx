/**
 * Ambient typing for `import page from "./page.mx"` under either loader
 * (`@markox/html/bun` or `@markox/vite-plugin`'s `.mx` handling).
 *
 * `any` rather than each file's real `Input` interface: per-file typing needs
 * a virtual-file projection of the compiled module, which is the phase-3
 * language server's job (see `@markox/typescript-plugin`'s equivalent role for
 * `.solid.mx`), not something this ambient declaration can derive on its own.
 */
declare module "*.mx" {
  const render: (input: any) => string;
  export default render;
}
