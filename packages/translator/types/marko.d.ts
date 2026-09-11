/**
 * Ambient typing for `import page from "./page.marko"` under either loader
 * (`@mxlang/translator/bun` or `@mxlang/vite-plugin`'s `.marko` handling).
 *
 * `any` rather than each file's real `Input` interface: per-file typing needs
 * a virtual-file projection of the compiled module, which is the phase-3
 * language server's job (see `@mxlang/typescript-plugin`'s equivalent role for
 * `.solid.mx`), not something this ambient declaration can derive on its own.
 */
declare module "*.marko" {
  const render: (input: any) => string;
  export default render;
}

/**
 * `.mx` is the official extension (decision 72); `.marko` above is the
 * accepted alias, identical treatment. Same shape, same reason.
 */
declare module "*.mx" {
  const render: (input: any) => string;
  export default render;
}
