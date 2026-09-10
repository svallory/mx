import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Per-rule tests for the translator.
 *
 * The golden fixtures assert rendered HTML for the paths that work; these
 * assert the paths that must *fail*, each with the message that names why.
 * A construct accepted and silently dropped reads as support from the outside
 * (decision 10 / S8), so every rejection is pinned to its wording here and to
 * the minimal input that produces it (S10).
 */

const src = (body: string) => (body.endsWith("\n") ? body : `${body}\n`);

describe("reactive constructs are rejected by name", () => {
  // Decision 54: these need a runtime MX's string target does not have. Each
  // must name the construct rather than fail obscurely or, worse, render it as
  // an unknown element.
  it.each([
    ["let", "<let/x=1/>", /`<let>` is reactive state/],
    ["effect", "<effect>{}</effect>", /`<effect>` is a reactive effect/],
    ["lifecycle", "<lifecycle onMount=f/>", /`<lifecycle>`/],
    [
      "await",
      "<await|v| =p><p>x</p></await>",
      /`<await>` suspends on a promise/,
    ],
    ["try", "<try><p>x</p></try>", /`<try>` is an error boundary/],
    ["client", "<client><p>x</p></client>", /`<client>`/],
    ["server", "<server><p>x</p></server>", /`<server>`/],
  ])("rejects <%s>", (_name, body, message) => {
    expect(() => compile(src(body), "r.mx")).toThrow(message);
  });
});

describe("<for> rejections", () => {
  it("rejects by= naming the reason", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const body = '<for|it| of=input.items by="id">${it}</for>';
    expect(() => compile(src(body), "by.mx")).toThrow(
      /by= is not supported in a standalone template/,
    );
  });

  it("rejects by= regardless of its value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const body = "<for|it| of=input.items by=anything>${it}</for>";
    expect(() => compile(src(body), "by2.mx")).toThrow(
      /by= is not supported in a standalone template/,
    );
  });

  it("rejects step=", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const body = "<for|n| from=0 to=10 step=2>${n}</for>";
    expect(() => compile(src(body), "step.mx")).toThrow(
      /step is not supported/,
    );
  });

  it("rejects a <for> with no iteration attribute", () => {
    expect(() => compile(src("<for|n|><p>x</p></for>"), "noiter.mx")).toThrow(
      /requires `of=`, `in=`, or `from=`/,
    );
  });
});

describe("every <for> form lowers", () => {
  it.each([
    ["of", "<for|item| of=input.items><li>x</li></for>", "of input.items"],
    [
      "of with index",
      "<for|item, i| of=input.items><li>x</li></for>",
      ".entries()",
    ],
    ["in", "<for|k, v| in=input.obj><li>x</li></for>", "Object.entries"],
    ["from/to", "<for|n| from=1 to=3><li>x</li></for>", "n <= 3"],
    ["from/until", "<for|n| from=0 until=2><li>x</li></for>", "n < 2"],
  ])("%s", (_name, body, expected) => {
    expect(compile(src(body), "for.mx").code).toContain(expected);
  });
});

describe("unknown tags", () => {
  // The silent-failure mode ADR 0001 names: without a registry, a core tag MX
  // cannot lower renders as an HTML element and nobody is told.
  it("rejects an unknown lowercase tag", () => {
    expect(() => compile(src("<bogus>x</bogus>"), "bogus.mx")).toThrow(
      /unknown tag `<bogus>`/,
    );
  });

  it("keeps hyphenated custom elements working", () => {
    expect(
      compile(src('<my-widget a="1">x</my-widget>'), "ce.mx").code,
    ).toContain("<my-widget");
  });

  it("rejects an unbound PascalCase tag", () => {
    expect(() => compile(src("<Card>x</Card>"), "pascal.mx")).toThrow(
      /`<Card>` has no matching import or `<define>` in scope/,
    );
  });

  it("rejects <else> with no preceding <if>", () => {
    expect(() => compile(src("<else><p>x</p></else>"), "else.mx")).toThrow(
      /`<else>` without a preceding `<if>`/,
    );
  });
});

describe("tag dispatch resolves by binding, not case", () => {
  it.each([
    ['import Card from "./c.mx"', "Card"],
    ['import * as Card from "./c.mx"', "Card"],
    ['import { Card } from "./c.mx"', "Card"],
    ['import { Card as Renamed } from "./c.mx"', "Renamed"],
    ['import Card, { Other } from "./c.mx"', "Card"],
  ])("%s binds %s", (importLine, local) => {
    const body = `${importLine}\n<${local}></${local}>`;
    expect(compile(src(body), "imports.mx").code).toContain(`${local}(`);
  });

  it("calls a lowercase import as a component", () => {
    const body = 'import layout from "./l.mx"\n<layout title="x"></layout>';
    expect(compile(src(body), "lower.mx").code).toContain("layout({");
  });

  it("lets a <define> shadow a same-named element", () => {
    const body = "<define/section>x</define>\n<section/>";
    expect(compile(src(body), "shadow.mx").code).toContain("out += section(");
  });
});

describe("module shape", () => {
  it("imports escape and default-exports the renderer", () => {
    const { code } = compile(src("<p>hi</p>"), "shape.mx");
    expect(code).toContain('import { escape } from "@markox/html";');
    expect(code).toContain("export default function (input: Input): string {");
    expect(code).toContain('let out = "";');
    expect(code).toContain("return out;");
  });

  it("concatenates rather than joining an array", () => {
    const { code } = compile(src("<p>a</p><p>b</p>"), "concat.mx");
    expect(code).toContain("out +=");
    expect(code).not.toContain(".join(");
  });

  it("emits void elements with no closing tag", () => {
    const { code } = compile(
      src('<div><br><img src="x.png"></div>'),
      "void.mx",
    );
    expect(code).toContain("<br>");
    expect(code).not.toContain("</br>");
    expect(code).not.toContain("</img>");
  });

  it("hoists imports and static blocks above the render function", () => {
    const body =
      'import Card from "./card.mx"\nstatic const G = "hi"\n<p>x</p>';
    const { code } = compile(src(body), "hoist.mx");
    const renderIndex = code.indexOf("export default function");
    expect(code.indexOf('import Card from "./card.mx"')).toBeLessThan(
      renderIndex,
    );
    // `static` names a module-scope binding; the keyword itself is not JS.
    expect(code).toContain('const G = "hi"');
    expect(code.indexOf('const G = "hi"')).toBeLessThan(renderIndex);
  });

  it("keeps the author's Input interface verbatim", () => {
    const body = "export interface Input { name: string }\n<p>x</p>";
    expect(compile(src(body), "iface.mx").code).toContain(
      "export interface Input { name: string }",
    );
  });

  it("emits <const> at render scope", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const body = "<const/x=1/>\n<p>${x}</p>";
    const { code } = compile(src(body), "const.mx");
    expect(code.indexOf("const x = 1;")).toBeGreaterThan(
      code.indexOf("export default function"),
    );
  });

  it("rejects an export other than interface Input", () => {
    const body = "export const x = 1\n<p>y</p>";
    expect(() => compile(src(body), "badexport.mx")).toThrow(
      /may only `export interface Input`/,
    );
  });
});

describe("placeholders", () => {
  it("escapes ${} and passes $!{} through raw", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const { code } = compile(src("<p>${a}</p><div>$!{b}</div>"), "ph.mx");
    expect(code).toContain("escape(a)");
    expect(code).toContain("out += (b);");
  });
});

describe("attributes", () => {
  it("escapes a static value at compile time whatever the author's quoting", () => {
    // A single-quoted value may legally contain a raw `"`, which would close
    // the emitted double-quoted attribute and start live markup (decision 42).
    const { code } = compile(src(`<a title='a" onerror="x'>go</a>`), "q.mx");
    expect(code).toContain("&quot;");
    expect(code).not.toContain('title="a" onerror=');
  });

  it("validates spread keys at runtime rather than escaping them", () => {
    const { code } = compile(src("<div ...input.attrs>z</div>"), "spread.mx");
    expect(code).toContain("Object.entries(input.attrs)");
    expect(code).toContain("test(key)");
  });

  it("emits a bare attribute as HTML's spelling of true", () => {
    expect(compile(src("<input required>"), "bool.mx").code).toContain(
      " required",
    );
  });

  it("merges shorthand class and id", () => {
    // The literal reaches the emitted module inside a JS string, so the
    // attribute quotes are backslash-escaped there.
    const { code } = compile(src("<div.card.wide#main>x</div>"), "sh.mx");
    expect(code).toContain('class=\\"card wide\\"');
    expect(code).toContain('id=\\"main\\"');
  });
});

describe("comments and doctype", () => {
  it("keeps an HTML comment and drops a line comment", () => {
    const body = "<p>a</p>\n<!-- keep -->\n// drop\n<p>b</p>";
    const { code } = compile(src(body), "c.mx");
    expect(code).toContain("<!-- keep -->");
    expect(code).not.toContain("drop");
  });

  it("emits the doctype verbatim", () => {
    const body = "<!doctype html>\n<html><body>x</body></html>";
    expect(compile(src(body), "d.mx").code).toContain("<!doctype html>");
  });
});
