declare module "@solidjs/babel-plugin" {
  import type { PluginItem } from "@babel/core";

  const plugin: (
    api: unknown,
    options?: Record<string, unknown>,
  ) => { plugins?: PluginItem[]; presets?: PluginItem[] };
  export default plugin;
}

declare module "@babel/preset-typescript" {
  import type { PluginItem } from "@babel/core";

  const preset: (
    api: unknown,
    options?: Record<string, unknown>,
  ) => { plugins?: PluginItem[]; presets?: PluginItem[] };
  export default preset;
}
