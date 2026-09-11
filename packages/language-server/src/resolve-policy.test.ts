import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

    expect(resolveHostPolicy(filePath)).toEqual({ host: "translator" });
  });

  it("falls back to the translator's default policy when neither signal is present", () => {
    const filePath = join(FIXTURES, "no-signal/App.mx");

    expect(resolveHostPolicy(filePath)).toEqual({ host: "translator" });
  });
});
