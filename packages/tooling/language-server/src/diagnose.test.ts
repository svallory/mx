import { describe, expect, it, vi } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

describe("diagnoseDocument", () => {
  it("reports one Error diagnostic for <let> under a strict policy", () => {
    const source = "<let/count=1/>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
      strict: true,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(diagnostics[0]?.source).toBe("mxlang");
    expect(diagnostics[0]?.message).toMatch(/let/i);
    // 1-based Marko line -> 0-based LSP line.
    expect(diagnostics[0]?.range.start.line).toBe(0);
  });

  it("reports nothing for a valid file", () => {
    const source = "<p>hello</p>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
    });

    expect(diagnostics).toEqual([]);
  });

  it("renders <let>'s initial value (no error) under the non-strict policy", () => {
    // `${count}` here is MX's own placeholder syntax inside the source
    // string being compiled, not a JS template literal — biome's
    // noTemplateCurlyInString can't tell the two apart.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template literal
    const source = "<let/count=1/>\n<p>${count}</p>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "html",
    });

    expect(diagnostics).toEqual([]);
  });

  it("never throws on an unexpected exception, and reports nothing", () => {
    const onUnexpectedError = vi.fn();

    // Deliberately violate the public input type to make the underlying
    // compiler throw a locationless TypeError. Real syntax errors now carry
    // `loc` and must become diagnostics, regardless of their concrete class.
    const diagnostics = diagnoseDocument(
      null as unknown as string,
      "file:///project/App.solid.mx",
      { host: "html" },
      onUnexpectedError,
    );

    expect(diagnostics).toEqual([]);
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
  });

  it("reports a Solid host error at its file-absolute position inside a .solid.mx region", () => {
    const source = `import { createSignal } from "solid-js";

export const view = () => (
  <div>
    <let/count=1/>
  </div>
);
`;
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 1,
      source: "mxlang",
      range: {
        start: { line: 4, character: 4 },
        end: { line: 4, character: 5 },
      },
    });
    expect(diagnostics[0]?.message).toMatch(/let/i);
  });

  it("reports an expression parse error inside a .solid.mx region", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a JS template literal
    const source = "export const view = () => (\n  <p>${a b}</p>\n);\n";
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 1, character: 9 },
      end: { line: 1, character: 10 },
    });
  });

  it("reports a TypeScript syntax error outside every .solid.mx region", () => {
    const source =
      "const answer: = 42;\nexport const view = () => <p>ok</p>;\n";
    const diagnostics = diagnoseDocument(
      source,
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 0, character: 14 },
      end: { line: 0, character: 15 },
    });
  });

  it("reports nothing for a clean .solid.mx document", () => {
    const diagnostics = diagnoseDocument(
      "export const view = () => <p>hello</p>;\n",
      "file:///project/App.solid.mx",
      { host: "solid" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("uses the Solid host profile for a whole-file .mx document", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=1/>\n",
      "file:///project/App.mx",
      { host: "solid" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/let/i);
    expect(diagnostics[0]?.range.start).toEqual({ line: 0, character: 0 });
  });
});

describe("the Preact host", () => {
  // `<let>` is valid Marko and renders its initial value under the html
  // host, so a diagnostic here can only come from the Preact host's own
  // declarations — which is what proves the switch routed the document.
  it("diagnoses a stateful tag through @mxlang/preact", () => {
    const diagnostics = diagnoseDocument(
      "<let/count=0/>\n<p>${count}</p>\n",
      "file:///app/greeting.mx",
      { host: "preact" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("useState");
  });

  it("reports nothing for a valid Preact-host document", () => {
    const diagnostics = diagnoseDocument(
      "export interface Input { name: string }\n<h1>${input.name}</h1>\n",
      "file:///app/greeting.mx",
      { host: "preact" },
    );

    expect(diagnostics).toEqual([]);
  });

  it("ignores `strict`, which this host has no looser mode for", () => {
    // Both spellings resolve to the same declarations: unlike the html host,
    // there is no second policy to select.
    for (const strict of [true, false]) {
      const diagnostics = diagnoseDocument(
        "<let/count=0/>\n<p>${count}</p>\n",
        "file:///app/greeting.mx",
        { host: "preact", strict },
      );
      expect(diagnostics).toHaveLength(1);
    }
  });
});

describe("the React host", () => {
  it("diagnoses a stateful tag through @mxlang/react", () => {
    const diagnostics = diagnoseDocument(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<let/count=0/>\n<p>${count}</p>\n",
      "file:///app/greeting.mx",
      { host: "react" },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("React's `useState`");
  });

  it("reports nothing for a valid React-host document", () => {
    const diagnostics = diagnoseDocument(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "export interface Input { name: string }\n<h1>${input.name}</h1>\n",
      "file:///app/greeting.mx",
      { host: "react" },
    );

    expect(diagnostics).toEqual([]);
  });
});
