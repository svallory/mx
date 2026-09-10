// Neither package has a pinned `@types/*` entry in this repo (see
// packages/oracle/src/ambient.d.ts for the same situation with
// `babel-preset-solid` and `@babel/preset-typescript`); these are used only
// from control.test.ts, so the shape only needs to cover that usage.

declare module "babel-preset-solid" {
  import type { PluginItem } from "@babel/core";

  const preset: (
    api: unknown,
    options?: Record<string, unknown>,
  ) => { plugins?: PluginItem[]; presets?: PluginItem[] };
  export default preset;
}

declare module "@babel/generator" {
  // biome-ignore lint/suspicious/noExplicitAny: the full Babel Node union
  function generate(node: any): { code: string };
  export default generate;
}
