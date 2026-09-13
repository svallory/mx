import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 5380;
const baseUrl = `http://localhost:${port}`;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server at ${url} did not respond`);
}

async function buildApp(): Promise<void> {
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
  await buildApp();
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = `${root}dist${name}`;
    if (!existsSync(path)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  await waitForServer(baseUrl);

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="count"]');
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("the MX + React app", () => {
  it("renders props and initial hook state", async () => {
    expect(await page.textContent("h1")).toBe("MX React counter");
    expect(await page.textContent('[data-testid="count"]')).toBe("3");
  });

  it("updates the hydrated counter", async () => {
    await page.click('[data-testid="inc"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("4");
    expect(await page.getAttribute('[data-testid="parity"]', "class")).toBe(
      "even",
    );
  });

  it("resets through a second emitted handler", async () => {
    await page.click('[data-testid="reset"]');
    expect(await page.textContent('[data-testid="count"]')).toBe("0");
  });

  it("catches a real thrown React render error through `<try>`", async () => {
    expect(await page.textContent('[data-testid="boom-ok"]')).toBe(
      "child rendered fine",
    );
    expect(await page.textContent('[data-testid="boom-caught"]')).toBe(
      "caught: boom from a React child",
    );
  });
});
