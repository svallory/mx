import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevServer } from "./helpers.ts";

let browser: Browser;
let server: { url: string; stop: () => void };
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startDevServer(5188);
  page = await browser.newPage();
});

afterAll(async () => {
  await page?.close();
  server?.stop();
  await browser?.close();
});

/**
 * Navigates to `url` and returns the raw response body.
 *
 * Deliberately not `page.content()`: that serializes the browser's parsed
 * DOM, which normalizes attributes and decodes entities — this asserts what
 * the server actually sent, not what Chromium reparsed it into.
 */
async function fetchHtml(url: string): Promise<string> {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  return (await response?.text()) ?? "";
}

describe("hono-app", () => {
  it("renders the <for> list server-side", async () => {
    const html = await fetchHtml(server.url);
    expect(html).toContain("<h1>MX on Hono</h1>");
    expect(html).toContain("0: alpha");
    expect(html).toContain("1: beta");
    expect(html).toContain("2: gamma");
  });

  it("renders the non-throwing <try> branch normally", async () => {
    const html = await fetchHtml(server.url);
    expect(html).toContain('data-testid="boom-ok"');
    expect(html).toContain("child rendered fine");
  });

  it("catches the thrown child through Hono's built-in ErrorBoundary", async () => {
    const html = await fetchHtml(server.url);
    expect(html).toContain('data-testid="boom-caught-2"');
    expect(html).toContain("caught: boom from a Hono child");
  });

  it("ships no client hydration script", async () => {
    // Hono's default `hono/jsx` server render is a plain string with no
    // resume markers, island wrappers, or hydration bootstrap — unlike
    // Preact's/React's client-hydrated output. This is the host's whole
    // claim for a static server-rendered page.
    const html = await fetchHtml(server.url);
    expect(html).not.toContain("<script");
  });
});
