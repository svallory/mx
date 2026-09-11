import { describe, expect, it, vi } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

describe("diagnoseDocument", () => {
  it("reports one Error diagnostic for <let> under a strict policy", () => {
    const source = "<let/count=1/>\n";
    const diagnostics = diagnoseDocument(source, "file:///project/App.mx", {
      host: "translator",
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
      host: "translator",
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
      host: "translator",
    });

    expect(diagnostics).toEqual([]);
  });

  it("never throws on an unexpected exception, and reports nothing", () => {
    const onUnexpectedError = vi.fn();

    // A source Marko's own parser rejects outright (unbalanced tag) throws
    // something that is not a TranslateError from @marko/compiler itself —
    // this exercises the catch-all branch, not the TranslateError branch.
    const diagnostics = diagnoseDocument(
      "<div",
      "file:///project/App.mx",
      { host: "translator" },
      onUnexpectedError,
    );

    expect(diagnostics).toEqual([]);
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
  });
});
