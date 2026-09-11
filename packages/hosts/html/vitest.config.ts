import { defineConfig } from "vitest/config";

// `bun.test.ts` imports `bun:test` and drives `Bun.plugin`/`Bun`'s own
// `import()` — Bun-runtime-only, so it runs under `bun run test:bun` instead
// (see package.json), not under this vitest project.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "src/bun.test.ts"],
  },
});
