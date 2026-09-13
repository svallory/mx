import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

function compile(source: string): string {
  return compileReactMx(source, "/fixtures/test.mx").code;
}

function markup(source: string): string {
  const match = compile(source).match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error("compiled module has no JSX return body");
  return match[1] as string;
}

describe("React target", () => {
  it("uses React's JSX source and DOM prop names", () => {
    const code = compile('<label class="field" for="name">Name</label>');
    expect(code).toContain("/** @jsxImportSource react */");
    expect(code).toContain(
      '<label className="field" htmlFor="name">Name</label>',
    );
  });

  it("uses React DOM's raw HTML prop", () => {
    expect(markup("<div>$!{input.html}</div>")).toBe(
      "<div dangerouslySetInnerHTML={{ __html: input.html }} />",
    );
  });

  it("keeps structured class and style semantics", () => {
    const code = compile(
      "<div class={active: input.on} style={color: input.color}>x</div>",
    );
    // Sliced verbatim from source (no space after `{`), the same seam that
    // keeps TypeScript type arguments (see packages/core's core.ts and the
    // identical assertions in the Preact and Solid host tests).
    expect(code).toContain("className={mxClass({active: input.on})}");
    expect(code).toContain("style={{color: input.color}}");
    expect(code).toContain('import { mxClass } from "@mxlang/react/runtime";');
  });

  it("shares keyed list lowering with Preact", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<for|item| of=input.items by="id"><p>${item.name}</p></for>',
    );
    expect(code).toContain('import { Fragment } from "react";');
    expect(code).toContain("<Fragment key={item.id}>");
  });

  it("imports React's boundary runtime for `<try>`", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch|error|><p>${error.message}</p></@catch></try>',
    );
    expect(code).toContain(
      'import { MxErrorBoundary } from "@mxlang/react/runtime";',
    );
    expect(code).toContain(
      "<MxErrorBoundary fallback={(error) => <p>{error.message}</p>}>",
    );
  });

  it("rejects Marko state with React-specific guidance", () => {
    expect(() => compile("<let/count=0/>")).toThrow("React's `useState`");
  });
});
