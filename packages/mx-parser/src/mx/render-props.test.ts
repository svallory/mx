import generate from "@babel/generator";
import type { Expression } from "@babel/types";
import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";

const parseMx = (source: string) => parse(source, "test.solid.mx");

/** Prints the sole top-level statement's expression for a `const el = <...>;` source. */
function printFirstExpression(source: string): string {
  const file = parseMx(source);
  const stmt = file.program.body[0] as unknown as {
    declarations: [{ init: Expression }];
  };
  const init = stmt.declarations[0].init;
  return generate(init).code;
}

function expectSyntaxError(source: string, expected: string) {
  let error: unknown;
  try {
    parseMx(source);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SyntaxError);
  expect((error as Error).message).toContain(expected);
}

/**
 * Decision 51, rule 1: tag params on *any* tag make the children a function.
 * This is what lets MX call Solid's own render-prop components natively.
 */
describe("tag params make the children a function", () => {
  it("lowers params on a component to a callback child", () => {
    const code = printFirstExpression(
      `const el = <For|item, i| each=xs()><li>\${item()}</li></For>;`,
    );
    expect(code).toContain("each={xs()}");
    expect(code).toContain("{(item, i) => <li>{item()}</li>}");
  });

  it("lowers params on an HTML element the same way", () => {
    // Solid has no meaning for a function child on a DOM element; MX lowers
    // it anyway rather than inventing a rule the target does not have.
    const code = printFirstExpression(
      `const el = <div|x|><span>\${x}</span></div>;`,
    );
    expect(code).toContain("<div>{x => <span>{x}</span>}</div>");
  });

  it("accepts destructured params", () => {
    const code = printFirstExpression(
      `const el = <Show|{ name }| when=user()><b>\${name}</b></Show>;`,
    );
    // `@babel/generator` breaks an ObjectPattern across lines, so the
    // assertion is on the collapsed form rather than the printed layout.
    expect(code.replace(/\s+/g, " ")).toContain(
      "{({ name }) => <b>{name}</b>}",
    );
  });

  it("accepts TypeScript-annotated params", () => {
    const code = printFirstExpression(
      `const el = <Show|u: User| when=user()><b>\${u.name}</b></Show>;`,
    );
    expect(code).toContain("(u: User) =>");
  });

  it("lowers empty params to a zero-argument arrow", () => {
    const code = printFirstExpression(`const el = <Wrap||><b>x</b></Wrap>;`);
    expect(code).toContain("<Wrap>{() => <b>x</b>}</Wrap>");
  });

  it("passes a single child through bare", () => {
    const code = printFirstExpression(`const el = <W|x|><b>\${x}</b></W>;`);
    expect(code).toContain("{x => <b>{x}</b>}");
    expect(code).not.toContain("<>");
  });

  it("wraps a multi-child body in a fragment", () => {
    const code = printFirstExpression(
      `const el = <W|x|><b>\${x}</b><i>y</i></W>;`,
    );
    expect(code).toContain("<>");
    expect(code).toContain("<b>{x}</b>");
    expect(code).toContain("<i>y</i>");
  });
});

/**
 * Decision 51, rule 2: `<@name>` inside a tag body becomes the prop `name` on
 * that tag.
 */
describe("attribute tags become props", () => {
  it("turns an element body into a prop", () => {
    const code = printFirstExpression(
      `const el = <Layout><@header><h1>Title</h1></@header></Layout>;`,
    );
    expect(code).toContain("header={<h1>Title</h1>}");
  });

  it("turns params into a function prop", () => {
    const code = printFirstExpression(
      `const el = <Errored><@fallback|e, reset|><p>\${e.message}</p></@fallback></Errored>;`,
    );
    expect(code).toContain("fallback={(e, reset) => <p>{e.message}</p>}");
  });

  it("wraps a text-only body in a fragment", () => {
    // A bare JSXText is not valid in expression position, so the body wraps;
    // `wrapChildren` makes that decision for every caller.
    const code = printFirstExpression(
      `const el = <Layout><@header>Title</@header></Layout>;`,
    );
    expect(code).toContain("header={<>Title</>}");
  });

  it("emits own attrs first, then attribute tags in source order, and keeps ordinary children", () => {
    const code = printFirstExpression(
      `const el = <Layout id="main"><@header>H</@header><p>body</p><@footer|year|>\${year}</@footer></Layout>;`,
    );
    const attrOrder = ["id=", "header=", "footer="].map((needle) =>
      code.indexOf(needle),
    );
    expect(attrOrder[0]).toBeGreaterThan(-1);
    expect(attrOrder[0]).toBeLessThan(attrOrder[1] as number);
    expect(attrOrder[1]).toBeLessThan(attrOrder[2] as number);
    expect(code).toContain("footer={year => ");
    // The non-attribute-tag children stay children.
    expect(code).toContain("<p>body</p>");
  });
});

describe("attribute tag parse errors", () => {
  it("rejects attributes on an attribute tag", () => {
    expectSyntaxError(
      `const el = <Layout><@header class="x">H</@header></Layout>;`,
      "attribute tags take params or a body, not attributes (v1)",
    );
  });

  it("rejects the same attribute tag twice", () => {
    expectSyntaxError(
      `const el = <Layout><@header>A</@header><@header>B</@header></Layout>;`,
      "attribute tag `@header` given twice",
    );
  });

  it("rejects an attribute tag at the top level", () => {
    expectSyntaxError(
      `const el = <@header>x</@header>;`,
      "attribute tag `<@header>` outside a tag body",
    );
  });

  it("rejects an attribute tag inside `<if>`", () => {
    expectSyntaxError(
      `const el = <if=cond><@header>x</@header></if>;`,
      "attribute tag `<@header>` inside `<if>`",
    );
  });

  it("rejects an attribute tag inside `<for>`", () => {
    expectSyntaxError(
      `const el = <for|x| of=xs()><@header>y</@header></for>;`,
      "attribute tag `<@header>` inside `<for>`",
    );
  });

  it("rejects an unknown attribute tag inside `<try>`", () => {
    expectSyntaxError(
      `const el = <try><@header>x</@header></try>;`,
      "attribute tag `<@header>` inside `<try>`",
    );
  });
});

/**
 * Decision 51, rule 3: `<try>` reads its two tags out of the generic
 * collector, so the shapes it emits are unchanged but the rejections it
 * inherits are the generic ones.
 */
describe("`<try>` on the generic attribute-tag path", () => {
  it("still lowers to Errored/Loading", () => {
    const code = printFirstExpression(
      `const el = <try><@catch|e, reset|><p>\${e.message}</p></@catch><@placeholder>Loading…</@placeholder><Body/></try>;`,
    );
    expect(code).toContain("<Errored fallback={(e, reset) =>");
    expect(code).toContain("<Loading fallback={<>Loading…</>}>");
  });

  it("reports a duplicate `<@catch>` through the generic message", () => {
    expectSyntaxError(
      `const el = <try><@catch|e|>a</@catch><@catch|e|>b</@catch></try>;`,
      "attribute tag `@catch` given twice",
    );
  });
});
