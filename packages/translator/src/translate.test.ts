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
