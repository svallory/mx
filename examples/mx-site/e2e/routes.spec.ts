import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevServer, startStaticServer } from "./helpers.ts";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/**
 * Navigates to `url` and returns the raw response body.
 *
 * Deliberately not `page.content()`: that serializes the browser's parsed
 * DOM, which normalizes boolean attributes to `attr=""` and decodes entities
 * — exactly the differences these tests need to see, so they would be
 * invisible through it.
 */
async function fetchHtml(page: Page, url: string): Promise<string> {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  return (await response?.text()) ?? "";
}

/**
 * Runs the shared assertions against one origin.
 *
 * `route` maps a page name to its path on that origin: the dev server
 * serves extensionless routes (`/list`), the static build serves `.html`
 * files (`/list.html`).
 */
function describeOrigin(
  label: string,
  getUrl: () => string,
  route: (name: "index" | "list" | "form" | "mixins" | "raw") => string,
) {
  describe(label, () => {
    let page: Page;

    beforeAll(async () => {
      page = await browser.newPage();
    });

    afterAll(async () => {
      await page.close();
    });

    it("/ renders the layout, doctype and head/meta", async () => {
      const html = await fetchHtml(page, `${getUrl()}${route("index")}`);
      expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<meta charset="utf-8"');
      expect(html).toContain("<title>Home — mx-site</title>");
      expect(html).toContain('class="site-header"');
      expect(html).toContain('class="callout"');
      expect(html).toContain("mx-site");
    });

    it("/list renders index-keyed and identity-keyed loops", async () => {
      const html = await fetchHtml(page, `${getUrl()}${route("list")}`);
      expect(html).toContain("<li>0: apple</li>");
      expect(html).toContain("<li>1: banana</li>");
      expect(html).toContain("<li>2: cherry</li>");
      expect(html).toContain('<li data-id="t1">Write docs</li>');
      expect(html).toContain('<li data-id="t2">Ship it</li>');
    });

    it("/form renders static, dynamic, boolean and spread attributes, and escapes user input", async () => {
      const html = await fetchHtml(page, `${getUrl()}${route("form")}`);
      // Static, dynamic, boolean, spread.
      expect(html).toContain('action="/submit"');
      expect(html).toContain('value="ada"');
      expect(html).toContain("checked");
      expect(html).toContain('placeholder="type here"');
      expect(html).toContain('data-testid="extra-input"');
      // A spread key that is not a valid attribute name must not appear.
      expect(html).not.toContain("bad>key");
      // A false-valued spread attribute must be omitted.
      expect(html).not.toContain('disabled=""');
      // A value containing <script> must render escaped, not as a live tag.
      expect(html).not.toContain("<script>alert");
      expect(html).toContain(
        "&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;",
      );
    });

    it("/mixins calls a define more than once and a define taking a block", async () => {
      const html = await fetchHtml(page, `${getUrl()}${route("mixins")}`);
      const badgeCount = html.match(/class="badge"/g)?.length ?? 0;
      expect(badgeCount).toBe(4); // 3 from the loop + 1 nested inside the second panel.
      expect(html).toContain("<h3>First panel</h3>");
      expect(html).toContain("<h3>Second panel</h3>");
      expect(html).toContain("<p>Plain body content.</p>");
    });

    it("raw output stays unescaped where escaped output is entity-encoded for the same data", async () => {
      const html = await fetchHtml(page, `${getUrl()}${route("raw")}`);
      expect(html).toContain(
        '<div class="raw"><h3>Raw output</h3><p><b>bold</b> & <i>italic</i></p></div>',
      );
      expect(html).toContain(
        '<div class="escaped"><h3>Escaped output</h3><p>&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;</p></div>',
      );
    });
  });
}

describe("mx-site", () => {
  describe("dev server", () => {
    let stop: () => void;
    let baseUrl: string;

    beforeAll(async () => {
      const server = await startDevServer(5273);
      baseUrl = server.url;
      stop = server.stop;
    });

    afterAll(() => stop());

    describeOrigin(
      "routes",
      () => baseUrl,
      (name) => (name === "index" ? "/" : `/${name}`),
    );
  });

  describe("static build", () => {
    let stop: () => void;
    let baseUrl: string;

    beforeAll(async () => {
      const server = await startStaticServer(5274);
      baseUrl = server.url;
      stop = server.stop;
    });

    afterAll(() => stop());

    describeOrigin(
      "routes",
      () => baseUrl,
      (name) => `/${name}.html`,
    );
  });
});
