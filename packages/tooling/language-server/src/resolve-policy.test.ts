import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveHostPolicy } from "./resolve-policy.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("resolveHostPolicy", () => {
  it("uses the package.json#mxlang field when present, walking up past a subdirectory with no package.json of its own", () => {
    const filePath = join(FIXTURES, "explicit-field/nested/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({
      host: "astro",
      strict: true,
    });
  });

  it("falls back to the sole @mxlang/* host dependency when no #mxlang field is present", () => {
    const filePath = join(FIXTURES, "single-dependency/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("falls back to the html default policy when neither signal is present", () => {
    const filePath = join(FIXTURES, "no-signal/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
  });

  it("accepts 'translator' as a deprecated alias for 'html' and warns", () => {
    const filePath = join(FIXTURES, "deprecated-alias/App.mx");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveHostPolicy(filePath)).toEqual({ host: "html" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: The 'translator' mxlang.host alias is deprecated and will be removed in a future release. Use 'html' instead.",
    );

    warnSpy.mockRestore();
  });
});
