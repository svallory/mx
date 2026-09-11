import mx from "@markox/vite-plugin";
import { defineConfig } from "vite";

// A minimal SSG: `vite build` bundles `src/build.ts` (an SSR/Node build, not
// a browser one) through MX's `.marko` handling, then the bundle is run with
// Node to actually write `dist/*.html`. This is the plugin's stock-`.marko`
// path (`compile()`, a string-returning function) — no Solid, no client
// runtime, unlike `examples/counter-app`.
export default defineConfig({
  plugins: [mx()],
  build: {
    ssr: "src/build.ts",
    outDir: "dist-ssr",
    target: "node22",
  },
  // Every compiled `.marko` page imports `escape` from `@markox/translator`.
  // Left un-external, rolldown bundles that import by parsing
  // `@markox/translator`'s own TS source (its `main` is `src/index.ts`,
  // unbuilt) — which pulls in `@marko/compiler`'s transitive TypeScript
  // parameter-property syntax that rolldown's strip-only mode rejects.
  // External keeps it a runtime import, resolved by Bun (which transpiles TS
  // natively) when the bundle runs.
  ssr: {
    external: ["@markox/translator"],
  },
});
