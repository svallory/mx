import { describe, expect, it } from "vitest";
import { AstroTemplateError, lowerAstroMx } from "./astro-template.ts";

/** Lowers a template with an empty fence, returning just the template half. */
function lower(template: string): string {
  const source = `---\nconst x = 1;\n---\n${template}`;
  return lowerAstroMx(source, "Test.amx").code.replace(
    "---\nconst x = 1;\n---\n",
    "",
  );
}

/** The error a template raises, for the error-path tests. */
function errorFor(template: string): AstroTemplateError {
  try {
    lower(template);
  } catch (error) {
    if (error instanceof AstroTemplateError) return error;
    throw error;
  }
  throw new Error("expected the template to fail lowering");
}

describe("lowerAstroMx", () => {
  it("copies the fence through byte for byte", () => {
    const source = `---\nimport Card from "./Card.astro";\nconst n = 1;\n---\n<p>hi</p>`;
    const { code } = lowerAstroMx(source, "Test.amx");

    expect(
      code.startsWith(
        '---\nimport Card from "./Card.astro";\nconst n = 1;\n---\n',
      ),
    ).toBe(true);
  });

  it("lowers a file with no fence at all", () => {
    const { code } = lowerAstroMx("<p>hi</p>", "Test.amx");
    expect(code).toBe("<p>hi</p>");
  });

  it("hoists a template static into the Astro fence", () => {
    const source = `---\nconst x = 1;\n---\nstatic const y = 2;\n<p>${"${x + y}"}</p>`;
    expect(lowerAstroMx(source, "Test.amx").code).toBe(
      `---\nconst x = 1;\nconst y = 2;\n---\n<p>{x + y}</p>`,
    );
  });

  it("keeps comments and multiple roots", () => {
    expect(lower("<!--first--><p>a</p><p>b</p>")).toBe(
      "<!--first--><p>a</p><p>b</p>",
    );
  });
});

describe("placeholders", () => {
  it("lowers `${expr}` to an Astro expression", () => {
    expect(lower("<h1>${title}</h1>")).toBe("<h1>{title}</h1>");
  });

  it("lowers `$!{expr}` to set:html, since Astro escapes by default", () => {
    expect(lower("<div>$!{input.content}</div>")).toBe(
      "<div><Fragment set:html={input.content} /></div>",
    );
  });

  it("escapes literal braces in text, which would otherwise open an expression", () => {
    expect(lower("<p>a {b} c</p>")).toBe("<p>a &#123;b&#125; c</p>");
  });
});

describe("<if>", () => {
  it("lowers to a ternary with a null arm when there is no else", () => {
    expect(lower("<if=on><p>yes</p></if>")).toBe(
      "{on ? (<Fragment><p>yes</p></Fragment>) : null}",
    );
  });

  it("lowers an else branch", () => {
    expect(lower("<if=on><p>y</p></if><else><p>n</p></else>")).toBe(
      "{on ? (<Fragment><p>y</p></Fragment>) : (<Fragment><p>n</p></Fragment>)}",
    );
  });

  it("chains else-if", () => {
    const out = lower(
      "<if=a><p>1</p></if><else if=b><p>2</p></else><else><p>3</p></else>",
    );
    expect(out).toBe(
      "{a ? (<Fragment><p>1</p></Fragment>) : b ? (<Fragment><p>2</p></Fragment>) : (<Fragment><p>3</p></Fragment>)}",
    );
  });

  it("rejects a condition-less <if>", () => {
    expect(errorFor("<if><p>x</p></if>").message).toMatch(
      /`<if>` without a condition/,
    );
  });

  it("rejects a stray <else>", () => {
    expect(errorFor("<else><p>x</p></else>").message).toMatch(
      /must follow an `<if>`/,
    );
  });
});

describe("<for>", () => {
  it("lowers `of=` to .map()", () => {
    expect(lower("<for|item| of=items><li>${item}</li></for>")).toBe(
      "{[...items].map((item) => (<Fragment><li>{item}</li></Fragment>))}",
    );
  });

  it("passes the index as the second param", () => {
    expect(lower("<for|item, i| of=items><li>${i}</li></for>")).toBe(
      "{[...items].map((item, i) => (<Fragment><li>{i}</li></Fragment>))}",
    );
  });

  it("lowers `in=` through Object.entries", () => {
    expect(lower("<for|k, v| in=obj><li>${k}</li></for>")).toBe(
      "{Object.entries(obj).map(([k, v]) => (<Fragment><li>{k}</li></Fragment>))}",
    );
  });

  it("lowers the inclusive `to=` range", () => {
    expect(lower("<for|n| from=1 to=3><li>${n}</li></for>")).toContain(
      "(3) - (1) + 1",
    );
  });

  it("lowers the exclusive `until=` range", () => {
    expect(lower("<for|n| from=1 until=3><li>${n}</li></for>")).toContain(
      "(3) - (1)",
    );
  });

  it("rejects `step=`, as the core does", () => {
    expect(
      errorFor("<for|n| from=1 to=9 step=2><li>${n}</li></for>").message,
    ).toMatch(/step is not supported/);
  });

  it("rejects a <for> with no params", () => {
    expect(errorFor("<for of=items><li>x</li></for>").message).toMatch(
      /needs tag params/,
    );
  });

  it("rejects a <for> with no iterable", () => {
    expect(errorFor("<for|n|><li>x</li></for>").message).toMatch(
      /requires `of=`, `in=`, or/,
    );
  });
});

describe("attributes", () => {
  it("passes a static attribute through", () => {
    expect(lower('<p class="card">x</p>')).toBe('<p class="card">x</p>');
  });

  it("wraps a dynamic attribute in braces", () => {
    expect(lower("<p title=name>x</p>")).toBe("<p title={name}>x</p>");
  });

  it("emits a bare attribute as HTML's spelling of true", () => {
    expect(lower("<input disabled>")).toBe("<input disabled />");
  });

  it("lowers a spread", () => {
    expect(lower("<p ...rest>x</p>")).toBe("<p {...rest}>x</p>");
  });

  it("lowers a structured class to Astro's class:list", () => {
    expect(lower("<p class={on: true}>x</p>")).toBe(
      "<p class:list={{on: true}}>x</p>",
    );
  });

  it("lowers an array class to class:list", () => {
    expect(lower('<p class=["a", {b: true}]>x</p>')).toBe(
      '<p class:list={["a", {b: true}]}>x</p>',
    );
  });

  it("hoists value ahead of type on an input, as Marko does", () => {
    expect(lower('<input type="text" value=v>')).toBe(
      '<input value={v} type="text" />',
    );
  });

  it("rejects an event-handler attribute method", () => {
    expect(errorFor("<button onClick() { go() }>x</button>").message).toMatch(
      /event handler and requires a runtime/,
    );
  });
});

describe("components and slots", () => {
  it("self-closes a childless component", () => {
    expect(lower("<Card title=t/>")).toBe("<Card title={t} />");
  });

  it("passes children through as the default slot", () => {
    expect(lower("<Card><p>x</p></Card>")).toBe("<Card><p>x</p></Card>");
  });

  it("lowers an attribute tag to an Astro named slot", () => {
    expect(lower("<Card><@header><h2>t</h2></@header></Card>")).toBe(
      '<Card><Fragment slot="header"><h2>t</h2></Fragment></Card>',
    );
  });

  it("rejects an attribute tag on an HTML element, which has no slots", () => {
    expect(errorFor("<div><@header>x</@header></div>").message).toMatch(
      /only a component accepts/,
    );
  });

  it("rejects tag params, which Astro has no render-prop form for", () => {
    expect(errorFor("<Card|item|><p>x</p></Card>").message).toMatch(
      /Astro passes markup through slots, not functions/,
    );
  });
});

describe("unsupported constructs", () => {
  it.each([
    ["let", "<let/count=1/>", /reactive state and requires a runtime/],
    ["effect", "<effect() { go() }/>", /reactive effect/],
    ["lifecycle", "<lifecycle onMount=f/>", /reactive lifecycle hook/],
    ["id", "<id/x/>", /allocates an identifier/],
    ["await", "<await=p><p>x</p></await>", /suspense-capable renderer/],
    ["return", "<return=1/>", /has no parent template/],
  ])("rejects <%s>", (_name, template, pattern) => {
    expect(errorFor(template).message).toMatch(pattern);
  });

  it("rejects <const>, which a template expression cannot declare", () => {
    expect(errorFor("<const/n=1/>").message).toMatch(
      /declare it in the `---` fence instead/,
    );
  });

  it("rejects <define>, pointing at a separate file", () => {
    expect(errorFor("<define/Row><p>x</p></define>").message).toMatch(
      /extract it into its own `\.amx` file/,
    );
  });

  it("rejects <try>, which Astro has no error boundary for", () => {
    expect(errorFor("<try><p>x</p></try>").message).toMatch(
      /needs an error boundary/,
    );
  });

  it("rejects a dynamic tag name", () => {
    expect(errorFor("<${Tag}><p>x</p></${Tag}>").message).toMatch(
      /resolves component names statically/,
    );
  });
});

describe("error positions", () => {
  it("reports the line in the enclosing file, past the fence", () => {
    // The fence is three lines, so the `<let>` on the template's first line is
    // line 4 of the file. That shift is `parseFragment`'s base-offset work,
    // which is the whole reason this host uses that front door.
    const source = `---\nconst x = 1;\n---\n<let/count=1/>`;
    try {
      lowerAstroMx(source, "Test.amx");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AstroTemplateError);
      expect((error as AstroTemplateError).line).toBe(4);
    }
  });
});
