import { defineConfig } from "vitest/config";

// Drives a real Chromium against `astro build`'s static output, and separately
// asserts the two builds that are *supposed* to fail. Behind the example's own
// `bun run e2e`, not the root `vitest run` (whose projects glob is
// `packages/*`), because it needs a browser and runs real builds.
export default defineConfig({
  test: {
    include: ["e2e/*.spec.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One `astro build` at a time: each is a heavy process, and two at once
    // contend for memory with nothing gained.
    fileParallelism: false,
  },
});
