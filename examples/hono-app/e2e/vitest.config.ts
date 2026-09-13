import { defineConfig } from "vitest/config";

// A real Chromium against a real server, so this lives behind the example's
// own `bun run e2e` rather than the root `vitest run` (`projects: ["packages/*"]`).
export default defineConfig({
  test: {
    include: ["e2e/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
