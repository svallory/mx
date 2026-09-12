import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression for the `new URL(uri).pathname` bug fixed in `server.ts`:
 * that API leaves percent-encoding intact and, for a Windows drive-letter
 * URI, keeps a leading slash (`/C:/Users/...`) that neither `path.join` nor
 * `path.dirname` treats as that drive's root — so the `package.json` walk in
 * `/core`'s `host-policy.ts` would silently find nothing and fall back to the
 * default policy. `fileURLToPath` is the correct primitive for both cases;
 * this test pins its behavior at the string level (no real Windows
 * filesystem needed — `{ windows: true }` forces Windows path semantics
 * regardless of the platform running the test).
 */
describe("fileURLToPath (regression: server.ts's URI-to-path conversion)", () => {
  it("decodes a percent-encoded space", () => {
    expect(fileURLToPath("file:///Users/dev/space%20in%20name/App.mx")).toBe(
      "/Users/dev/space in name/App.mx",
    );
  });

  it("strips the leading slash from a Windows drive-letter URI", () => {
    expect(
      fileURLToPath("file:///C:/Users/dev/App.mx", { windows: true }),
    ).toBe("C:\\Users\\dev\\App.mx");
  });
});
