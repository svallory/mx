import { describe, expect, it } from "vitest";
import { mxClass } from "./runtime.ts";

describe("mxClass", () => {
  it("joins a structured class value", () => {
    expect(mxClass(["card", { active: true, hidden: false }])).toBe(
      "card active",
    );
  });

  it("drops falsy entries", () => {
    expect(mxClass([null, undefined, false, "", "x"])).toBe("x");
  });
});
