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
const screenshot = fileURLToPath(new URL("./todomvc.png", import.meta.url));

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

/** Walks through the full TodoMVC flow against a running app. */
async function assertTodoFlow(page: Page): Promise<void> {
  await expect.poll(() => page.textContent("h1")).toBe("todos");

  const input = page.locator(".new-todo");
  await input.fill("Buy milk");
  await input.press("Enter");
  await input.fill("Walk the dog");
  await input.press("Enter");

  const items = page.locator(".todo-list li");
  await expect.poll(() => items.count()).toBe(2);

  // Toggle the first todo complete.
  await items.nth(0).locator(".toggle").check();
  await expect
    .poll(() => items.nth(0).getAttribute("class"))
    .toContain("completed");

  // Filter: Active shows only the remaining one.
  await page.locator(".filters a", { hasText: "Active" }).click();
  await expect.poll(() => items.count()).toBe(1);
  await expect
    .poll(() => items.first().textContent())
    .toContain("Walk the dog");

  // Filter: Completed shows only the toggled one.
  await page.locator(".filters a", { hasText: "Completed" }).click();
  await expect.poll(() => items.count()).toBe(1);
  await expect.poll(() => items.first().textContent()).toContain("Buy milk");

  // Back to All, edit the active todo via double-click + Enter.
  await page.locator(".filters a", { hasText: "All" }).click();
  await expect.poll(() => items.count()).toBe(2);

  const activeLabel = page.locator(".todo-list li:not(.completed) label");

  // Escape cancels the edit and keeps the original title.
  await activeLabel.dblclick();
  const editInput = page.locator(".todo-list li.editing .edit");
  await editInput.fill("Discarded edit");
  await editInput.press("Escape");
  await expect.poll(() => activeLabel.textContent()).toBe("Walk the dog");

  // Enter commits the edit.
  await activeLabel.dblclick();
  await editInput.fill("Walk the cat");
  await editInput.press("Enter");
  await expect.poll(() => activeLabel.textContent()).toBe("Walk the cat");

  // Clear completed leaves only the edited todo.
  await page.locator(".clear-completed").click();
  await expect.poll(() => items.count()).toBe(1);
  await expect
    .poll(() => items.first().textContent())
    .toContain("Walk the cat");
}

describe("todomvc-app", () => {
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

    it("runs the full add/toggle/filter/edit/clear flow, then persists across reload", async () => {
      const [page, watch] = await openPage(url);

      await assertTodoFlow(page);
      await page.screenshot({ path: screenshot });

      const storageKey = "mx-todomvc";
      const stored = await page.evaluate(
        (key) => localStorage.getItem(key),
        storageKey,
      );
      expect(stored).toContain("Walk the cat");

      await page.reload({ waitUntil: "networkidle" });
      await expect.poll(() => page.locator(".todo-list li").count()).toBe(1);
      await expect
        .poll(() => page.locator(".todo-list li").first().textContent())
        .toContain("Walk the cat");

      expect(watch.errors).toEqual([]);
      await page.close();
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
      await server?.close();
    });

    it("adds and toggles a todo from the built dist/", async () => {
      const [page, watch] = await openPage(url);

      const input = page.locator(".new-todo");
      await input.fill("Ship it");
      await input.press("Enter");

      const items = page.locator(".todo-list li");
      await expect.poll(() => items.count()).toBe(1);

      await items.first().locator(".toggle").check();
      await expect
        .poll(() => items.first().getAttribute("class"))
        .toContain("completed");

      expect(watch.errors).toEqual([]);
      await page.close();
    });
  });
});
