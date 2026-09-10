import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Per-rule tests for the stock-Marko translator.
 *
 * Two things are pinned here that the fixtures cannot pin. The fixtures assert
 * rendered HTML for constructs that *work*; these assert the policy table of
 * decision 65 — which constructs are accepted with no output (inert), which
 * are errors because the target genuinely cannot express them, and the
 * conventions that differ from `@markox/html`'s dialect.
 *
 * The distinction the table turns on: a construct that only configures
 * behaviour after the first render is inert, and one that contributes output
 * bytes must lower. "My code cannot do this" is never a row.
 */

const src = (body: string) => (body.endsWith("\n") ? body : `${body}\n`);
const file = "/tmp/mx-translator-test/probe.marko";

describe("an inert tag is inert only in its declared shape", () => {
  // Inert means the construct emits nothing — never that a body or an extra
  // attribute may be discarded. `<effect><div>x</div></effect>` compiled clean
  // with the `<div>` gone before this rule existed: a successful compile that
  // silently deleted authored markup, the S8 failure class the field guard
  // exists to close. Marko itself rejects both shapes.
  // `<effect>` is the tag that actually reaches this guard. `<log>`, `<debug>`,
  // `<id>` and `<lifecycle>` are `openTagOnly` in Marko's own definition, so a
  // body on those is a parse error before any translator runs — the guard
  // still declares `body: "none"` for them, for a taglib that omits that parse
  // option, but the reachable case to pin is this one.
  it("rejects a body on <effect>", () => {
    expect(() =>
      compile(src("<effect() { go() }><div>inside</div></effect>"), file),
    ).toThrow(/`<effect>` does not support body content/);
  });

  it("rejects an unexpected attribute on <effect>", () => {
    expect(() => compile(src('<effect foo="bar"/>'), file)).toThrow(
      /`<effect>` does not support the `foo` attribute/,
    );
  });

  it("accepts the attributes a tag's own definition allows", () => {
    // Per tag, not uniform, because Marko is: `<lifecycle foo="bar"/>`
    // compiles there while `<effect foo="bar"/>` does not — a lifecycle tag's
    // attributes are its configuration.
    const { code } = compile(
      src('<p>a</p>\n<lifecycle onMount() { } foo="bar"/>'),
      file,
    );
    expect(code).toContain('out += "<p>a</p>"');
  });

  it("rejects a spread on an inert tag", () => {
    expect(() => compile(src("<effect ...input.attrs/>"), file)).toThrow(
      /spread attributes on `<effect>` are not supported/,
    );
  });

  it("still accepts <script>'s raw-text body, which Marko declares", () => {
    // `text: true` in Marko's own tag definition: the body is client script
    // source, genuinely consumed and genuinely emitting nothing.
    const { code } = compile(
      src("<script>console.log(1)</script>\n<p>a</p>"),
      file,
    );
    expect(code).toContain('out += "<p>a</p>"');
    expect(code).not.toContain("console.log");
  });
});

describe("class:foo / style:foo modifiers", () => {
  // Marko 5.42.5 has no such modifier: its own parser rejects every form
  // ("`class:active` is not a valid attribute, did you mean
  // `class={ active: condition }`?"), so matching Marko means rejecting them.
  // The message must be this dialect's own — the shared core's fallback is
  // `@markox/html`'s "standalone template" wording, which is `.mx` vocabulary
  // leaking into a Marko-parity target.
  it.each([
    ["class:active", "<div class:active=input.on>a</div>"],
    ["style:color", '<div style:color="red">d</div>'],
  ])("rejects %s with Marko's own guidance", (_name, body) => {
    expect(() => compile(src(body), file)).toThrow(
      /is not a valid attribute; Marko rejects this form too/,
    );
    expect(() => compile(src(body), file)).not.toThrow(/standalone template/);
  });
});

describe("bindings may not shadow the input parameter", () => {
  // The emitted module is `function (input: Input)`, so a `const input = …`
  // inside it makes the template's own input unreachable with no diagnostic.
  // Marko rejects the same thing ("Duplicate declaration of `input`").
  it.each([
    ["let", "<let/input=1/>"],
    ["const", "<const/input=1/>"],
  ])("rejects <%s> binding `input`", (_name, body) => {
    expect(() => compile(src(body), file)).toThrow(
      /collides with the template input parameter/,
    );
  });

  // A tag param is a *nested* scope — a `for (const … of …)` head, an arrow's
  // parameter list — so an ordinary JS shadow is correct there and the
  // template's own input stays reachable outside the loop. Marko draws the
  // same line: it renders `<for|input|>` and rejects `<let/input>`. Rejecting
  // the param form would be an implementation limit stated as a rule, which
  // decision 65 forbids.
  it.each([
    ["for", "<for|input| of=input.items><p>${input}</p></for>"],
    ["for with index", "<for|input, i| of=input.items><p>${input}</p></for>"],
    ["define", '<define/Row|input|><li>${input}</li></define>\n<Row("a")/>'],
  ])("shadows `input` in a %s tag param, as Marko does", (_name, body) => {
    expect(() => compile(src(body), file)).not.toThrow();
  });

  it("leaves any other binding name alone", () => {
    const { code } = compile(src("<for|item| of=[1,2]><p>y</p></for>"), file);
    expect(code).toContain("for (const item of");
  });
});

describe("<html-comment> lowers placeholders", () => {
  it("emits interpolated values rather than dropping them", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<html-comment>build ${input.sha}</html-comment>";
    const { code } = compile(src(body), file);
    expect(code).toContain("escapeComment(input.sha)");
    expect(code).toContain("function escapeComment");
  });

  it("escapes only `>`, as Marko's own _escape_comment does", () => {
    const body = "<html-comment>a > b < c & d</html-comment>";
    const { code } = compile(src(body), file);
    expect(code).toContain("a &gt; b < c & d");
  });

  it("treats markup inside a comment as text, as Marko's taglib declares", () => {
    // `<html-comment>` is `text: true` in Marko's own definition, so a `<div>`
    // in there never becomes a tag — it is comment text, escaped by the same
    // `>`-only rule. The translator's "only text and placeholders" guard still
    // stands for a taglib that omits that parse option, but this is the
    // behaviour a stock `.marko` file actually gets.
    const body = "<html-comment>x<div>y</div></html-comment>";
    expect(compile(src(body), file).code).toContain(
      "<!--x<div&gt;y</div&gt;-->",
    );
  });
});

describe("inert constructs (decision 65): accepted, no output", () => {
  // Each was verified against Marko's own server render: the emitted HTML is
  // byte-identical with and without the construct. Rejecting them would be an
  // implementation limit dressed as a rule.
  it.each([
    ["effect", "<p>a</p>\n<effect() { go() }/>"],
    ["lifecycle", "<p>a</p>\n<lifecycle onMount() { }/>"],
    ["script", "<p>a</p>\n<script>console.log(1)</script>"],
    ["log", "<p>a</p>\n<log=1/>"],
    ["debug", "<p>a</p>\n<debug/>"],
  ])("accepts <%s> with no emitted output", (_name, body) => {
    const { code } = compile(src(body), file);
    expect(code).toContain('out += "<p>a</p>"');
    expect(code).not.toContain("console.log");
  });

  it("accepts by= on <for> with no effect on the output", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const withBy = '<for|it| of=input.items by="id"><li>${it}</li></for>';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const without = "<for|it| of=input.items><li>${it}</li></for>";
    expect(compile(src(withBy), file).code).toBe(
      compile(src(without), file).code,
    );
  });
});

describe("statement blocks", () => {
  it("runs a `server` block and hoists it, as Marko does", () => {
    // Verified against Marko: a server block runs during a server render and
    // its bindings are readable from the template. Classifying it as inert
    // would silently drop a binding the rest of the template reads.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "server const S = 41 + 1\n<p>${S}</p>";
    const { code } = compile(src(body), file);
    expect(code).toContain("const S = 41 + 1");
    expect(code.indexOf("const S = 41 + 1")).toBeLessThan(
      code.indexOf("export default function"),
    );
    expect(code).toContain("escape(S)");
  });

  it("rejects <return>, naming the parent template it cannot reach", () => {
    expect(() => compile(src("<return=42/>"), file)).toThrow(
      /`<return>` provides a value to the \*parent\* template/,
    );
  });
});

describe("evaluate-initial-value constructs (decision 65)", () => {
  it("<let> binds its initial value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const { code } = compile(src("<let/count=5/>\n<p>${count}</p>"), file);
    expect(code).toContain("const count = 5;");
    expect(code).toContain("escape(count)");
  });

  it("<const> binds its value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<const/dbl=2 * 3/>\n<p>${dbl}</p>";
    expect(compile(src(body), file).code).toContain("const dbl = 2 * 3;");
  });

  it(":= binds to the initial value, with no update path", () => {
    const body = '<let/v="hi"/>\n<input value:=v>';
    const { code } = compile(src(body), file);
    expect(code).toContain('const v = "hi";');
    expect(code).toContain("escape(v)");
  });
});

describe("error constructs: the target genuinely cannot express them", () => {
  it("rejects <await>, naming why a synchronous render cannot", () => {
    const body = "<await|v| =input.p><p>${v}</p></await>";
    expect(() => compile(src(body), file)).toThrow(/`<await>` suspends/);
  });

  it("rejects <try> with a <@placeholder>", () => {
    const body =
      "<try><p>b</p><@placeholder><p>loading</p></@placeholder></try>";
    expect(() => compile(src(body), file)).toThrow(/second render pass/);
  });
});

describe("<try> without a placeholder is a plain try/catch", () => {
  it("lowers the body and its <@catch>", () => {
    const body = "<try><p>b</p><@catch|e|><p>err</p></@catch></try>";
    const { code } = compile(src(body), file);
    expect(code).toContain("try {");
    expect(code).toContain("} catch (e) {");
  });
});

describe("class and style take Marko's structured values", () => {
  it.each([
    ["object", "<div class={a: true, b: false}>x</div>", "classValue({"],
    ["array", '<div class=["x", {y: true}]>z</div>', "classValue(["],
    ["style object", '<div style={color: "red"}>s</div>', "styleValue({"],
  ])("%s", (_name, body, expected) => {
    expect(compile(src(body), file).code).toContain(expected);
  });

  it("emits the helper only when something calls it", () => {
    const plain = compile(src("<p>a</p>"), file).code;
    expect(plain).not.toContain("function classValue");
    expect(plain).not.toContain("function renderDynamic");
  });
});

describe("attribute tags are renderables, Marko's convention", () => {
  // `@markox/html` passes callable function props (S3); Marko passes
  // renderables read with `<${input.header}/>`, and a repeated attribute tag
  // is an array. The two conventions are incompatible, which is exactly why
  // this is a separate package rather than a flag.
  it("passes a single attribute tag as a named prop", () => {
    const body =
      'import Panel from "./panel.marko"\n<Panel><@header>H</@header></Panel>';
    expect(compile(src(body), file).code).toContain("header: (");
  });

  it("passes a repeated attribute tag as an array", () => {
    const body =
      'import List from "./list.marko"\n<List><@item>a</@item><@item>b</@item></List>';
    const { code } = compile(src(body), file);
    expect(code).toMatch(/item: \[\(/);
  });

  it("names ordinary children `content`, the prop Marko's own tags read", () => {
    const body = 'import Panel from "./panel.marko"\n<Panel>body</Panel>';
    const { code } = compile(src(body), file);
    expect(code).toContain("content: (");
    expect(code).not.toContain("children:");
  });
});

describe("dynamic tags", () => {
  it("lowers `<${expr}/>` through the runtime dispatcher", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    const { code } = compile(src("<${input.tag}/>"), file);
    expect(code).toContain("renderDynamic(input.tag");
    expect(code).toContain("function renderDynamic");
  });
});

describe("comments", () => {
  it("emits <html-comment> and strips a plain comment, as Marko does", () => {
    const body = "<html-comment>keep</html-comment>\n<!-- drop -->\n<p>x</p>";
    const { code } = compile(src(body), file);
    expect(code).toContain("<!--keep-->");
    expect(code).not.toContain("drop");
  });
});

describe("the eight-field guard", () => {
  // Marko's parser fills in more than any one path reads. Everything a path
  // does not lower is reported by name rather than dropped — the silent-drop
  // class S8 exists to close, and the reason a third-party translator is hard
  // to write correctly.
  it.each([
    ["tag params on an element", "<div|a|>x</div>", /tag params/],
    ["tag variable on an element", "<div/ref>x</div>", /tag variable/],
    [
      "an attribute tag on an element",
      "<div><@header>x</@header></div>",
      /attribute tag `@header`/,
    ],
  ])("rejects %s", (_what, body, message) => {
    expect(() => compile(src(body), file)).toThrow(message);
  });
});

describe("module shape", () => {
  it("imports escape and default-exports the renderer", () => {
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain('import { escape } from "@markox/translator";');
    expect(code).toContain("export default function (input: Input): string {");
  });

  it("hoists imports and static blocks above the render function", () => {
    const body = 'static const G = "hi"\n<p>x</p>';
    const { code } = compile(src(body), file);
    expect(code.indexOf('const G = "hi"')).toBeLessThan(
      code.indexOf("export default function"),
    );
  });
});
