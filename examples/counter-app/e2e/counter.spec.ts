import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import {
  build,
  createServer,
  type PreviewServer,
  preview,
  type ViteDevServer,
} from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const screenshot = fileURLToPath(new URL("./counter.png", import.meta.url));

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

interface ConsoleWatch {
  errors: string[];
}

/** Opens a page, recording console errors and uncaught exceptions. */
async function openPage(url: string): Promise<[Page, ConsoleWatch]> {
  const page = await browser.newPage();
  const watch: ConsoleWatch = { errors: [] };

  page.on("console", (message) => {
    if (message.type() === "error") watch.errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    watch.errors.push(String(error));
  });

  await page.goto(url, { waitUntil: "networkidle" });
  return [page, watch];
}

/** Asserts the rendered counter works: heading, then two clicks. */
async function assertCounter(page: Page): Promise<void> {
  await expect.poll(() => page.textContent("h1")).toBe("MX counter");

  const button = page.locator("button");
  await expect.poll(() => button.textContent()).toBe("Count: 0");

  await button.click();
  await expect.poll(() => button.textContent()).toBe("Count: 1");

  await button.click();
  await expect.poll(() => button.textContent()).toBe("Count: 2");
}

describe("counter-app", () => {
  describe("dev server", () => {
    let server: ViteDevServer;
    let url: string;

    beforeAll(async () => {
      // port 0 lets the OS pick a free port.
      server = await createServer({
        root,
        server: { port: 0 },
        logLevel: "warn",
      });
      await server.listen();
      const resolved = server.resolvedUrls?.local[0];
      if (!resolved) throw new Error("dev server produced no local URL");
      url = resolved;
    });

    afterAll(async () => {
      await server?.close();
    });

    it("renders and increments the MX counter", async () => {
      const [page, watch] = await openPage(url);

      await assertCounter(page);
      await page.screenshot({ path: screenshot });

      expect(watch.errors).toEqual([]);
      await page.close();
    });

    it("serves a source map that points back at the .solid.mx file", async () => {
      // Criterion 6: the transformed module Vite hands the browser must carry
      // a map whose `sources` names the MX file, so a breakpoint or an error
      // resolves into the source the user actually wrote.
      const result = await server.transformRequest("/src/Counter.solid.mx");

      expect(result).not.toBeNull();
      expect(result?.map).toBeTruthy();

      const map = result?.map as { sources?: string[]; mappings?: string };
      const sources = map.sources ?? [];
      expect(
        sources.some((source) => source.includes("Counter.solid.mx")),
      ).toBe(true);
      expect(map.mappings?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe("production build", () => {
    let server: PreviewServer;
    let url: string;

    beforeAll(async () => {
      await build({ root, logLevel: "warn" });
      server = await preview({
        root,
        preview: { port: 0 },
        logLevel: "warn",
      });
      const resolved = server.resolvedUrls?.local[0];
      if (!resolved) throw new Error("preview server produced no local URL");
      url = resolved;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server?.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("renders and increments from the built dist/", async () => {
      const [page, watch] = await openPage(url);

      await assertCounter(page);

      expect(watch.errors).toEqual([]);
      await page.close();
    });
  });
});
