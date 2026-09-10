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
  // Decision 65 reclassified `by=`: it is reconciler input, naming which item
  // a DOM node belongs to across re-renders. A one-shot string render performs
  // no reconciliation, so it changes no emitted byte — verified against
  // Marko's own server render, which produces identical HTML with and without
  // it. "This target ignores it" is a fact about the target, so it is accepted
  // rather than rejected; the old rejection was an implementation limit
  // dressed as a rule. An invalid `by=` expression still dies at Marko's parse
  // stage for free.
  it("accepts by= with no effect on the output", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const withBy = '<for|it| of=input.items by="id">${it}</for>';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const without = "<for|it| of=input.items>${it}</for>";
    expect(compile(src(withBy), "by.mx").code).toBe(
      compile(src(without), "by.mx").code,
    );
  });

  it("accepts by= as an expression, with no effect on the output", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const withBy = "<for|it| of=input.items by=(it) => it.id>${it}</for>";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const without = "<for|it| of=input.items>${it}</for>";
    expect(compile(src(withBy), "by2.mx").code).toBe(
      compile(src(without), "by2.mx").code,
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
  // Each form is pinned by the loop *kind* it produces, not by the spelling of
  // its bounds: a `<for>`'s own expressions are bound to a temporary before
  // the loop opens, so a tag param may shadow a name the iterable itself uses
  // (`<for|input| of=input.items>`) without landing in the temporal dead zone.
  it.each([
    [
      "of",
      "<for|item| of=input.items><li>x</li></for>",
      "for (const item of $for",
    ],
    [
      "of with index",
      "<for|item, i| of=input.items><li>x</li></for>",
      ".entries()",
    ],
    ["in", "<for|k, v| in=input.obj><li>x</li></for>", "Object.entries"],
    ["from/to", "<for|n| from=1 to=3><li>x</li></for>", "n <= $for"],
    ["from/until", "<for|n| from=0 until=2><li>x</li></for>", "n < $for"],
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

describe("attribute tags outside a component call", () => {
  // Marko separates `<@name>` children into `node.attributeTags` for EVERY
  // tag, not just components. A path that walks only `body.body` therefore
  // renders none of them and reports nothing — the content vanishes from a
  // successful compile. That is the S8 silent-drop failure in its worst form,
  // so each parent kind is pinned here with the message that names it.
  it.each([
    ["element", "<div><@header>x</@header></div>", "`<div>`"],
    [
      "for",
      "<for|it| of=input.items><@foo>b</@foo><li>x</li></for>",
      "`<for>`",
    ],
    ["if", "<if=true><@foo>b</@foo><p>x</p></if>", "`<if>`"],
    ["define", "<define/x><@foo>y</@foo></define>", "`<define>`"],
    ["fragment", "<fragment><@foo>y</@foo><p>z</p></fragment>", "`<fragment>`"],
  ])("rejects an attribute tag on %s", (_kind, body, parent) => {
    expect(() => compile(src(body), "at.mx")).toThrow(/attribute tag `@/);
    expect(() => compile(src(body), "at.mx")).toThrow(
      new RegExp(`on ${parent.replace(/[`<>]/g, "\\$&")}`),
    );
  });

  it("still lowers attribute tags on a component call", () => {
    const body =
      'import Card from "./c.mx"\n<Card><@header>x</@header><p>y</p></Card>';
    const { code } = compile(src(body), "ok.mx");
    expect(code).toContain("header:");
    expect(code).toContain("children:");
  });
});

describe("node fields the translator does not lower", () => {
  // Everything Marko's parser fills in that this target has no lowering for.
  // Each was silently dropped before the round-2 audit; a drop reads as
  // support from the outside, so each names itself instead.
  it.each([
    [
      "tag arguments on a component",
      'import Card from "./c.mx"\n<Card("a", 1)>x</Card>',
      /tag arguments `\(\.\.\.\)`/,
    ],
    ["tag variable on an element", "<div/ref>x</div>", /tag variable `\/ref`/],
    [
      "type arguments on a component",
      'import Card from "./c.mx"\n<Card<string> a="1">x</Card>',
      /type arguments on/,
    ],
    ["tag params on an element", "<div|a|>x</div>", /tag params `\|\.\.\.\|`/],
    [
      "an attribute modifier",
      '<div class:foo="x">y</div>',
      /attribute modifier `class:foo`/,
    ],
    [
      "attributes on <fragment>",
      '<fragment class="x"><p>z</p></fragment>',
      /`<fragment>` takes no attributes/,
    ],
  ])("rejects %s", (_what, body, message) => {
    expect(() => compile(src(body), "fields.mx")).toThrow(message);
  });
});

describe("a bare top-level placeholder", () => {
  // Concise mode has no separate shape for a `${expr}` line: it arrives as a
  // MarkoTag whose *name* is the expression, with no attributes and no body,
  // rather than as a MarkoPlaceholder. Getting this wrong drops the value
  // silently or reports a bogus dynamic-tag error, so it is pinned here as
  // well as at the `placeholder-first` fixture.
  it("renders as an escaped placeholder, not a dynamic tag", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const { code } = compile(src("${input.name}"), "top.mx");
    expect(code).toContain("escape(input.name)");
  });

  it("still rejects a genuine dynamic tag name", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
    const body = '<${input.tag} class="x">body</>';
    expect(() => compile(src(body), "dyn.mx")).toThrow(
      /dynamic tag name is not supported/,
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
