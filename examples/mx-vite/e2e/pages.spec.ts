import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 5372;
const baseUrl = `http://localhost:${port}`;

/** Waits until `url` responds or `timeoutMs` elapses. */
async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Server not up yet; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}

/** Runs `vite build` then the emitted SSR bundle, writing `dist/*.html`. */
async function buildSite(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build: ChildProcess = spawn("bun", ["run", "build"], { cwd: root });
    build.on("error", reject);
    build.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build failed with exit code ${code}`));
    });
  });
}

let browser: Browser;
let server: Server;
let page: Page;

beforeAll(async () => {
  await buildSite();

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = `${root}/dist${name}`;
    if (!existsSync(path)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  await waitForServer(baseUrl);

  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("mx-vite static build", () => {
  it("/ renders the home page compiled from a .mx template", async () => {
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    const html = await response?.text();

    expect(html?.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>Hello, world</h1>");
    expect(html).toContain('<a href="/about.html">About</a>');
  });

  it("/about.html renders the second .mx page", async () => {
    const response = await page.goto(`${baseUrl}/about.html`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    const html = await response?.text();

    expect(html).toContain("<h1>About</h1>");
    expect(html).toContain("@markox/vite-plugin");
  });
});
