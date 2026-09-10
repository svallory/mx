import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const appPath = fileURLToPath(new URL("../src/App.solid.mx", import.meta.url));

let browser: Browser;
let server: ViteDevServer;
let url: string;
let original: string;

beforeAll(async () => {
  original = readFileSync(appPath, "utf8");
  browser = await chromium.launch();
  server = await createServer({ root, server: { port: 0 }, logLevel: "warn" });
  await server.listen();
  const resolved = server.resolvedUrls?.local[0];
  if (!resolved) throw new Error("dev server produced no local URL");
  url = resolved;
});

afterAll(async () => {
  // Always put the file back, even if an assertion failed mid-test.
  writeFileSync(appPath, original);
  await server?.close();
  await browser?.close();
});

describe("HMR", () => {
  it("applies an MX edit without a full page reload", async () => {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });

    await expect.poll(() => page.textContent("h1")).toBe("MX counter");

    // A full reload wipes this; an HMR update leaves it in place.
    await page.evaluate(() => {
      (window as unknown as { __marker?: number }).__marker = 42;
    });

    writeFileSync(appPath, original.replace("MX counter", "MX counter edited"));

    await expect
      .poll(() => page.textContent("h1"), { timeout: 15_000 })
      .toBe("MX counter edited");

    const marker = await page.evaluate(
      () => (window as unknown as { __marker?: number }).__marker,
    );
    expect(marker).toBe(42);

    await page.close();
  });
});
