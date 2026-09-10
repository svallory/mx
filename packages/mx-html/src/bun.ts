import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { compile } from "./index.ts";

/**
 * Registers an `onLoad` for `.mx` files: `compile()`'s output is plain
 * TypeScript (an `import`, an optional `export interface Input`, and a
 * default-exported function), so `loader: "ts"` hands it straight to Bun's
 * own stripper — no JSX, no second transform needed.
 *
 * Usable both as a preload (`bunfig.toml`'s `preload = ["@markox/html/bun"]`
 * runs a preloaded module for its side effects — it does not itself call
 * `Bun.plugin` on a default export — so this module registers itself at
 * import time) and at runtime (`import mxPlugin from "@markox/html/bun";
 * Bun.plugin(mxPlugin)`, which registers the same plugin object again;
 * `Bun.plugin` is idempotent for an already-registered plugin object).
 */
const mxPlugin: BunPlugin = {
  name: "mx-html",
  setup(build) {
    build.onLoad({ filter: /\.mx$/ }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const { code } = compile(source, path);
      return { contents: code, loader: "ts" };
    });
  },
};

Bun.plugin(mxPlugin);

export default mxPlugin;
