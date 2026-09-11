import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { compile } from "./index.ts";

/**
 * Registers an `onLoad` for `.marko` files: `compile()`'s output is plain
 * TypeScript (an `import`, an optional `export interface Input`, and a
 * default-exported function), so `loader: "ts"` hands it straight to Bun's
 * own stripper — no JSX, no second transform needed.
 *
 * Usable both as a preload (`bunfig.toml`'s `preload = ["@mxlang/translator/bun"]`
 * runs a preloaded module for its side effects — it does not itself call
 * `Bun.plugin` on a default export — so this module registers itself at
 * import time) and at runtime (`import markoPlugin from "@mxlang/translator/bun";
 * Bun.plugin(markoPlugin)`, which registers the same plugin object again;
 * `Bun.plugin` is idempotent for an already-registered plugin object).
 *
 * `.mx` is the official extension (decision 72), `.marko` an accepted alias
 * with identical treatment. `.solid.mx` is a different file kind (TSX with
 * MX regions, handled by `@mxlang/vite-plugin`) and must not match here —
 * the negative lookbehind excludes it despite ending in `.mx`.
 */
const MARKO_FILTER = /(?<!\.solid)\.(?:mx|marko)$/;

const markoPlugin: BunPlugin = {
  name: "mxlang-translator",
  setup(build) {
    build.onLoad({ filter: MARKO_FILTER }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const { code } = compile(source, path);
      return { contents: code, loader: "ts" };
    });
  },
};

Bun.plugin(markoPlugin);

export default markoPlugin;
