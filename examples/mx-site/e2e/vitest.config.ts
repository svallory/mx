import { defineConfig } from "vitest/config";

// The e2e suite drives a real Chromium against a real server, so it lives
// behind the example's own `bun run e2e` rather than in the root `vitest run`
// (whose `projects` glob covers `packages/*` only).
export default defineConfig({
  test: {
    include: ["e2e/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
