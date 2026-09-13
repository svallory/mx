import { defineConfig } from "vitest/config";

// Drives a real Chromium against the production build; lives behind this
// example's own `bun run e2e`, not the root `vitest run` (`packages/*` only).
export default defineConfig({
  test: {
    include: ["e2e/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
