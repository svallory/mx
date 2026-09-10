import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";
import { walkMxTemplate } from "./template.ts";

/**
 * Whole-file `.mx` template mode (`mxMode: "template"`).
 *
 * The reactive constructs each get their own test because the brief's contract
 * is not merely "this fails" but "this fails *naming the construct*": a
 * standalone template has no runtime, and an author who wrote `<let>` needs to
 * be told that, not handed a generic syntax error.
 */

function parseTemplate(source: string) {
  return parse(source, "test.mx", { mxMode: "template" });
}

function templateError(source: string): Error {
  try {
    parseTemplate(source);
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a parse error, but the template parsed");
}

describe("mxMode: template", () => {
  it("parses a whole file of top-level tags", () => {
    const template = walkMxTemplate("<h1>a</h1>\n<p>b</p>\n");
    const elements = template.children.filter((c) => c.kind === "element");
    expect(elements).toHaveLength(2);
    expect(template.errors).toEqual([]);
  });

  it("enables concise (indentation) mode", () => {
    const template = walkMxTemplate("div.card\n  p -- hello\n");
    const [root] = template.children.filter((c) => c.kind === "element");
    expect(root?.kind === "element" && root.element.staticName).toBe("div");
    expect(template.errors).toEqual([]);
  });

  it("collects import, static and export statement tags", () => {
    const source = [
      'import Button from "./button.mx"',
      "static const N = 5",
      "export interface Input { name: string }",
      "<p>x</p>",
      "",
    ].join("\n");
    const template = walkMxTemplate(source);
    expect(template.statements.map((s) => s.kind)).toEqual([
      "import",
      "static",
      "export",
    ]);
    expect(template.errors).toEqual([]);
  });

  it("returns a File carrying the template on extra.mxTemplate", () => {
    const file = parseTemplate("<p>x</p>\n");
    expect(file.program.body).toEqual([]);
    const template = (
      file as unknown as { extra?: { mxTemplate?: { children: unknown[] } } }
    ).extra?.mxTemplate;
    expect(template?.children.length).toBeGreaterThan(0);
  });

  it("records a doctype as a child, in document order", () => {
    // htmljs-parser drops `<!doctype html>` from text and element events
    // entirely and reports it only through `onDoctype`; without that handler a
    // full HTML page silently loses its doctype.
    const template = walkMxTemplate("<!doctype html>\n<html></html>\n");
    const [first] = template.children;
    expect(first?.kind).toBe("doctype");
    expect(template.errors).toEqual([]);
  });

  it("reports a parse error with a position", () => {
    const err = templateError("<div>\n  <p>unterminated\n");
    expect(err.message).toMatch(/test\.mx:\d+:\d+/);
  });
});

describe("template mode rejects runtime-only constructs", () => {
  // Each message must name the construct and say standalone MX has no runtime,
  // so the author learns which line to change and why it cannot work.
  const cases: Array<[string, string, string]> = [
    ["<let>", "<let/count=0/>\n<p>x</p>\n", "`<let>`"],
    ["<effect>", "<effect>doThing()</effect>\n<p>x</p>\n", "`<effect>`"],
    ["<await>", "<await=promise()>\n  <p>x</p>\n</await>\n", "`<await>`"],
    ["<script>", "<script>doThing()</script>\n<p>x</p>\n", "`<script>`"],
    [":=", "<input value:=state.name>\n", "`:=`"],
  ];

  for (const [label, source, expected] of cases) {
    it(`names ${label} in the error`, () => {
      const err = templateError(source);
      expect(err.message).toContain(expected);
      expect(err.message).toMatch(/runtime/i);
    });
  }
});

describe("expression mode is unchanged", () => {
  it("still parses .solid.mx by default", () => {
    const file = parse("const el = <div>x</div>;", "a.solid.mx");
    expect(file.program.body).toHaveLength(1);
  });

  it("treats an explicit expression mode the same as the default", () => {
    const withOption = parse("const el = <div>x</div>;", "a.solid.mx", {
      mxMode: "expression",
    });
    expect(withOption.program.body).toHaveLength(1);
  });
});
