import { describe, expect, it } from "vitest";
// biome-ignore lint/suspicious/noShadowRestrictedNames: importing the export under test by its real name; the global it shadows is deprecated and unused here
import { escape } from "./escape.ts";

describe("escape", () => {
  it("escapes all five HTML characters", () => {
    expect(escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes the ampersand first, so escapes are not re-escaped", () => {
    // The wrong order turns `<` into `&amp;lt;`.
    expect(escape("<")).toBe("&lt;");
    expect(escape("&lt;")).toBe("&amp;lt;");
  });

  it("renders null and undefined as the empty string, not their names", () => {
    expect(escape(null)).toBe("");
    expect(escape(undefined)).toBe("");
  });

  it("coerces other non-strings with String()", () => {
    expect(escape(42)).toBe("42");
    expect(escape(0)).toBe("0");
    expect(escape(false)).toBe("false");
    expect(escape(["a", "b"])).toBe("a,b");
  });

  it("leaves text with nothing to escape untouched", () => {
    expect(escape("plain text 123")).toBe("plain text 123");
  });

  it("escapes a quote so an attribute value cannot break out", () => {
    expect(escape('" onerror="alert(1)')).toBe("&quot; onerror=&quot;alert(1)");
  });
});
