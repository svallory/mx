import { defineConfig } from "vitest/config";

// The e2e suite drives a real Chromium and a real Vite server, so it lives
// behind the example's own `bun run e2e` rather than in the root `vitest run`
// (whose `projects` glob covers `packages/*` only).
export default defineConfig({
  test: {
    include: ["e2e/todomvc.spec.ts"],
    // Dev server start, browser launch, build and preview all happen inside
    // these tests; the default 5s timeout is far too short.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
