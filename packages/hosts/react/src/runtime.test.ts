import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";

function Ok(): ReactNode {
  return createElement("p", null, "fine");
}

describe("React runtime", () => {
  it("renders a transparent boundary on the server", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          MxErrorBoundary,
          { fallback: "caught" },
          createElement(Ok),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("renders an unsuspended placeholder subtree", () => {
    expect(
      renderToStaticMarkup(
        createElement(
          MxPlaceholder,
          { fallback: "loading" },
          createElement(Ok),
        ),
      ),
    ).toBe("<p>fine</p>");
  });

  it("selects a function fallback after React marks an error caught", () => {
    const boundary = new MxErrorBoundary({
      fallback: (error) => createElement("p", null, (error as Error).message),
    });
    boundary.state = MxErrorBoundary.getDerivedStateFromError(
      new Error("boom"),
    );
    expect(renderToStaticMarkup(boundary.render())).toBe("<p>boom</p>");
  });

  it("joins structured class values", () => {
    expect(mxClass(["card", { active: true, hidden: false }, [12]])).toBe(
      "card active 12",
    );
  });
});
