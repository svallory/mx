import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emitTemplate } from "./emit.ts";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the compiled templates call `escape` by this name, so the harness must bind it under the same one
import { escape } from "./escape.ts";
import { compile } from "./index.ts";

/**
 * The golden suite: every fixture is compiled, run against its `input.json`,
 * and its output compared to `expected.html`.
 *
 * This asserts on *rendered HTML* rather than on the emitted TypeScript. The
 * emitted code is an implementation detail that should be free to improve;
 * what the language promises is the HTML a template produces for an input, and
 * that is what a fixture pins. A test over emitted text would fail on every
 * formatting change while proving nothing about correctness.
 */

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures-mx",
);

/**
 * Runs a compiled template.
 *
 * The emitted module is TypeScript with ESM imports, which cannot be `eval`ed
 * directly. Both are stripped instead: the type annotations are the only TS in
 * the output (a fixed set the emitter itself produced, not arbitrary source),
 * and the imports are resolved by hand — `escape` is passed in, and a component
 * import is compiled from its own `.mx` file beside the fixture.
 */
function render(dir: string, source: string, input: unknown): string {
  const { code } = compile(source, join(dir, "input.mx"));

  const componentNames: string[] = [];
  const componentFns: Array<(props: Record<string, unknown>) => string> = [];

  // `import Card from "./card.mx"` -> compile ./card.mx and bind `Card`.
  const importRe = /^import\s+(\w+)\s+from\s+"(\.[^"]+\.mx)"$/gm;
  for (const match of code.matchAll(importRe)) {
    const [, name, relative] = match as unknown as [string, string, string];
    const componentSource = readFileSync(join(dir, relative), "utf8");
    componentNames.push(name);
    componentFns.push(makeRenderer(dir, componentSource));
  }

  const body = code
    // Drop every import; each one is supplied as a parameter below.
    .replace(/^import\s.*$/gm, "")
    // Drop the exported interface and the type annotations the emitter wrote.
    .replace(/^export interface Input \{[\s\S]*?\}$/gm, "")
    .replace(/^export default function \(input: Input\): string \{$/m, "")
    .replace(/\}\s*$/, "");

  const fn = new Function(
    "escape",
    ...componentNames,
    "input",
    `${body}\nreturn out;`,
  ) as (escapeFn: typeof escape, ...rest: unknown[]) => string;

  return fn(escape, ...componentFns, input);
}

/** A component `.mx` file as a callable `(props) => string`. */
function makeRenderer(
  dir: string,
  source: string,
): (props: Record<string, unknown>) => string {
  return (props) => render(dir, source, props);
}

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("golden fixtures", () => {
  it("finds the fixture suite", () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuous, so the count is asserted rather than assumed.
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of fixtures) {
    it(`renders ${name}`, () => {
      const dir = join(fixturesDir, name);
      const source = readFileSync(join(dir, "input.mx"), "utf8");
      const input = JSON.parse(
        readFileSync(join(dir, "input.json"), "utf8"),
      ) as unknown;
      const expected = readFileSync(join(dir, "expected.html"), "utf8");

      expect(render(dir, source, input)).toBe(expected);
    });
  }
});

describe("emitted module shape", () => {
  it("imports escape from @markox/html and default-exports the renderer", () => {
    const { code } = compile("<p>hi</p>\n", "shape.mx");
    expect(code).toContain('import { escape } from "@markox/html";');
    expect(code).toContain("export default function (input: Input): string {");
    expect(code).toContain('let out = "";');
    expect(code).toContain("return out;");
  });

  it("builds the string by concatenation, not an array join", () => {
    const { code } = compile("<p>a</p><p>b</p>\n", "concat.mx");
    expect(code).toContain("out +=");
    expect(code).not.toContain(".join(");
    expect(code).not.toContain("[]");
  });

  it("self-closes void elements per HTML, with no closing tag", () => {
    const { code } = compile('<div><br><img src="x.png"></div>\n', "void.mx");
    expect(code).toContain("<br>");
    expect(code).not.toContain("</br>");
    expect(code).not.toContain("</img>");
  });

  it("hoists imports and static blocks to module scope", () => {
    const source = [
      'import Card from "./card.mx"',
      'static const GREETING = "hi"',
      "<p>x</p>",
      "",
    ].join("\n");
    const { code } = compile(source, "hoist.mx");
    const renderIndex = code.indexOf("export default function");
    expect(code.indexOf('import Card from "./card.mx"')).toBeLessThan(
      renderIndex,
    );
    // `static` names a module-scope binding; the keyword itself is not JS.
    expect(code).toContain('const GREETING = "hi"');
    expect(code.indexOf('const GREETING = "hi"')).toBeLessThan(renderIndex);
  });

  it("keeps the author's Input interface verbatim", () => {
    const source = [
      "export interface Input { name: string; count: number }",
      "<p>x</p>",
      "",
    ].join("\n");
    const { code } = compile(source, "iface.mx");
    expect(code).toContain(
      "export interface Input { name: string; count: number }",
    );
  });

  it("emits a const at render scope, inside the function", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${x}` is MX placeholder syntax in template source, not a JS template literal
    const source = ["<const/x=1/>", "<p>${x}</p>", ""].join("\n");
    const { code } = compile(source, "const.mx");
    const renderIndex = code.indexOf("export default function");
    expect(code.indexOf("const x = 1;")).toBeGreaterThan(renderIndex);
  });

  it("returns a source map naming the file", () => {
    const { map } = compile("<p>hi</p>\n", "map.mx");
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(["map.mx"]);
  });
});

describe("whitespace", () => {
  // The rule itself is `normalizeText`, tested in the parser package; these
  // pin that the string target actually applies it rather than re-implementing
  // it, which is the failure the shared function exists to prevent.
  const html = (source: string) => render(fixturesDir, source, {});

  it("drops a whitespace run containing a newline", () => {
    expect(html("<p>\n  a\n</p>\n<p>\n  b\n</p>\n")).toBe("<p>a</p><p>b</p>");
  });

  it("collapses a newline-free run to one space", () => {
    expect(html("<p>a   b</p>\n")).toBe("<p>a b</p>");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: `${" "}` is MX's whitespace escape hatch in template source, not a JS template literal
  it('honours ${" "} as the escape hatch', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same — this string is MX source, not JS
    expect(html('<p>a</p>${" "}<p>b</p>\n')).toBe("<p>a</p> <p>b</p>");
  });
});

describe("emitTemplate", () => {
  it("is exported for callers that already have a parsed template", () => {
    expect(typeof emitTemplate).toBe("function");
  });
});

describe("by= is rejected", () => {
  // A one-shot string render has no reconciler to key against, so accepting
  // `by=` and silently discarding it (as the emitter used to) reads as
  // support from the outside when there is none — decision 10.
  it("rejects a for-of loop with by=", () => {
    const source = '<for|it, i| of=input.items by="id">${it}</for>\n';
    expect(() => compile(source, "by.mx")).toThrow(
      /by= is not supported in a standalone template/,
    );
  });

  it("rejects by= regardless of its value", () => {
    const source = "<for|it, i| of=input.items by=totalGarbage>${it}</for>\n";
    expect(() => compile(source, "by2.mx")).toThrow(
      /by= is not supported in a standalone template/,
    );
  });
});
