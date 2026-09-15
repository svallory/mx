import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { compile } from "./index.ts";

/**
 * Registers an `onLoad` for `.mx` files: `compile()`'s output is plain
 * TypeScript (an `import`, an optional `export interface Input`, and a
 * default-exported function), so `loader: "ts"` hands it straight to Bun's
 * own stripper — no JSX, no second transform needed.
 *
 * Usable both as a preload (`bunfig.toml`'s `preload = ["@mxlang/html/bun"]`
 * runs a preloaded module for its side effects — it does not itself call
 * `Bun.plugin` on a default export — so this module registers itself at
 * import time) and at runtime (`import markoPlugin from "@mxlang/html/bun";
 * Bun.plugin(markoPlugin)`, which registers the same plugin object again;
 * `Bun.plugin` is idempotent for an already-registered plugin object).
 *
 * `.mx` is the only extension this loader accepts. `.marko` is deliberately
 * not registered: MX only supports the MX 1.0 subset of Marko syntax, so
 * treating a real `.marko` file as MX would silently claim support it does
 * not have. `.solid.mx` is a different file kind (TSX with MX regions,
 * handled by `@mxlang/vite-plugin`) and must not match here — the negative
 * lookbehind excludes it despite ending in `.mx`.
 */
const MX_FILTER = /(?<!\.solid)\.mx$/;

const markoPlugin: BunPlugin = {
  name: "mxlang-translator",
  setup(build) {
    build.onLoad({ filter: MX_FILTER }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const { code } = compile(source, path);
      return { contents: code, loader: "ts" };
    });
  },
};

Bun.plugin(markoPlugin);

export default markoPlugin;
