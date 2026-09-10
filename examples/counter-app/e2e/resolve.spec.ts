import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Resolution forms driven through a real Vite server rather than a stubbed
 * plugin context. These are the cases the plugin's own path arithmetic used to
 * get wrong: an id that is not a plain relative path never reached `load` at
 * all, so the module 404'd or ENOENT'd on a fresh graph.
 *
 * KNOWN ISSUE — this suite's `afterAll` does not settle under vitest, so the
 * file reports a hook timeout even though all four assertions pass. The hang
 * is in tearing down a Vite dev server inside vitest, not in the plugin: the
 * same `server.close()` returns in ~1ms from a plain Node script against this
 * same config, and `counter.spec.ts`/`hmr.spec.ts` close their own dev servers
 * in seconds. Three fixes were tried and all behaved identically (4 passing
 * tests, hung teardown): `configFile: false` with inline plugins, the
 * example's real config, and `middlewareMode` with no `listen()`. Left as-is
 * rather than worked around blindly; `bun run e2e` therefore runs the other
 * two specs, and this one is run on demand.
 */
describe("id resolution through a real server", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    // Uses the example's own vite.config.ts, so `mx()` sits ahead of `solid()`
    // exactly as a user would have it; only the alias this suite needs is
    // added on top.
    //
    // `middlewareMode` (no `listen()`): these tests drive `transformRequest`
    // directly and never fetch over HTTP, so the listening server is pure
    // overhead — and under vitest its handle keeps `close()` from settling,
    // which times out the suite even though every test has passed.
    server = await createServer({
      root,
      server: { middlewareMode: true },
      logLevel: "warn",
      resolve: {
        alias: {
          "@app": fileURLToPath(new URL("../src", import.meta.url)),
        },
      },
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("transforms a root-relative .solid.mx id", async () => {
    const result = await server.transformRequest("/src/Counter.solid.mx");

    expect(result).not.toBeNull();
    expect(result?.code).toContain("Count:");
  });

  it("transforms an aliased .solid.mx id", async () => {
    const result = await server.transformRequest("@app/Counter.solid.mx");

    expect(result).not.toBeNull();
    expect(result?.code).toContain("Count:");
  });

  it("re-fetches after the module graph is cleared", async () => {
    // The HMR path re-resolves from scratch. If `resolveId` depended on a
    // cached graph entry (or produced a path that is not on disk), this second
    // request would ENOENT rather than return the module again.
    const first = await server.transformRequest("/src/Counter.solid.mx");
    expect(first).not.toBeNull();

    server.moduleGraph.invalidateAll();

    const second = await server.transformRequest("/src/Counter.solid.mx");
    expect(second).not.toBeNull();
    expect(second?.code).toContain("Count:");
  });

  it("serves the raw MX source for a ?raw request", async () => {
    // `?raw` asks for the file's text. The plugin must decline the id
    // entirely so Vite serves the real `.solid.mx`; claiming it would either
    // return the compiled module or point Vite's raw handler at the virtual
    // `.tsx` path, which does not exist on disk.
    const result = await server.transformRequest("/src/Counter.solid.mx?raw");

    expect(result).not.toBeNull();
    // MX source, not printed JSX: the attribute method is still a method and
    // the placeholder has not become a JSX expression container.
    expect(result?.code).toContain("onClick()");
    expect(result?.code).not.toContain("onClick={");
  });
});
