import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";

// `@babel/generator` has no pinned `@types/babel__generator` in this repo, so
// it is brought in untyped rather than adding a new dependency for one test
// helper; every call site below already casts through `unknown`.
// biome-ignore lint/suspicious/noExplicitAny: untyped import, see above
const generate = require("@babel/generator").default as (node: any) => {
  code: string;
};

const parseMx = (source: string) => parse(source, "test.solid.mx");

/** Prints the sole top-level statement's expression for a `const el = <...>;` source. */
function printFirstExpression(source: string): string {
  const file = parseMx(source);
  const stmt = file.program.body[0] as unknown as {
    declarations: [{ init: unknown }];
  };
  const init = stmt.declarations[0].init;
  return generate(init).code;
}

/** Walks the AST collecting every node of a given type. */
function collect(node: unknown, type: string, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, type, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) out.push(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    collect(record[key], type, out);
  }
  return out;
}

function parseError(source: string): Error {
  try {
    parseMx(source);
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a parse error");
}

describe("if / else if / else", () => {
  it("lowers <if=cond> to <Show when={cond}>", () => {
    const code = printFirstExpression(`const el = <if=cond()>A</if>;`);
    expect(code).toBe("<Show when={cond()}>A</Show>;".replace(";", ""));
  });

  it("lowers if/else to Show with a fallback", () => {
    const code = printFirstExpression(
      `const el = <div><if=cond()>A</if><else>B</else></div>;`,
    );
    expect(code).toContain("<Show when={cond()} fallback={B}>A</Show>");
  });

  it("wraps a multi-child else body in a fragment", () => {
    const code = printFirstExpression(
      `const el = <div><if=cond()>A</if><else><p>B</p><p>C</p></else></div>;`,
    );
    expect(code).toContain("fallback={<>");
  });

  it("passes a single-element else body bare, not wrapped in a fragment", () => {
    const code = printFirstExpression(
      `const el = <div><if=cond()>A</if><else><Login /></else></div>;`,
    );
    expect(code).toContain("fallback={<Login />}");
    expect(code).not.toContain("fallback={<>");
  });

  it("lowers one else-if to nested Show via fallback", () => {
    const code = printFirstExpression(
      `const el = <div><if=a()>A</if><else if=b()>B</else><else>C</else></div>;`,
    );
    expect(code).toContain("when={a()}");
    expect(code).toContain("when={b()}");
    expect(code).not.toContain("Switch");
    // The inner Show (for b) is nested inside the outer Show's fallback.
    const shows = collect(
      parseMx(
        `const el = <div><if=a()>A</if><else if=b()>B</else><else>C</else></div>;`,
      ),
      "JSXElement",
    ) as {
      openingElement: { name: { name: string } };
    }[];
    const showNames = shows
      .map((s) => s.openingElement.name.name)
      .filter((n) => n === "Show");
    expect(showNames).toHaveLength(2);
  });

  it("lowers two or more else-ifs to Switch/Match", () => {
    const file = parseMx(
      `const el = <div><if=a()>A</if><else if=b()>B</else><else if=c()>C</else><else>D</else></div>;`,
    );
    const switches = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    const names = switches.map((s) => s.openingElement.name.name);
    expect(names).toContain("Switch");
    expect(names.filter((n) => n === "Match")).toHaveLength(3);
  });

  it("uses the callback child form for tag params on if", () => {
    // Tag params are written before the `=cond` shorthand, matching `<for>`'s
    // own `<for|item, i| of=...>` order.
    const file = parseMx(`const el = <if|u|=user()>x</if>;`);
    const shows = collect(file, "JSXElement") as {
      children: {
        type: string;
        expression?: { type: string; params: unknown[] };
      }[];
    }[];
    const show = shows[0] as (typeof shows)[number];
    expect(show.children).toHaveLength(1);
    expect(show.children[0]?.type).toBe("JSXExpressionContainer");
    expect(show.children[0]?.expression?.type).toBe("ArrowFunctionExpression");
    expect(show.children[0]?.expression?.params).toHaveLength(1);
  });

  it("rejects Marko args form <if(cond)>", () => {
    const err = parseError(`const el = <if(cond())>x</if>;`);
    expect(err.message).toContain("<if(cond)>");
  });

  it("rejects tag params on <else>", () => {
    const err = parseError(
      `const el = <div><if=a()>A</if><else|x|>B</else></div>;`,
    );
    expect(err.message).toContain("tag params");
  });

  it("rejects <else> without a preceding <if>", () => {
    const err = parseError(`const el = <div><p>x</p><else>B</else></div>;`);
    expect(err.message).toContain("<else>");
  });

  it("rejects <else if> without a preceding <if>", () => {
    const err = parseError(
      `const el = <div><p>x</p><else if=b()>B</else></div>;`,
    );
    expect(err.message).toContain("<else if>");
  });

  it("ignores whitespace-only text between </if> and <else>", () => {
    const code = printFirstExpression(
      `const el = <div><if=cond()>A</if>\n  <else>B</else></div>;`,
    );
    expect(code).toContain("fallback={B}");
  });
});

describe("for", () => {
  it("lowers <for|it,i| of=xs()> to <Index>", () => {
    const file = parseMx(`const el = <for|it, i| of=xs()><li>x</li></for>;`);
    const indexEls = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: { name: { name: string } }[];
      };
      children: { expression?: { params: unknown[] } }[];
    }[];
    const index = indexEls[0] as (typeof indexEls)[number];
    expect(index.openingElement.name.name).toBe("Index");
    expect(index.openingElement.attributes.map((a) => a.name.name)).toEqual([
      "each",
    ]);
    expect(index.children[0]?.expression?.params).toHaveLength(2);
  });

  it("lowers by=identity to native <For>, no import", () => {
    const file = parseMx(
      `const el = <for|it, i| of=xs() by=identity><li>x</li></for>;`,
    );
    const els = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
      extra?: { mx?: { needsImport?: string[] } };
    }[];
    const forEl = els[0] as (typeof els)[number];
    expect(forEl.openingElement.name.name).toBe("For");
    expect(forEl.extra?.mx?.needsImport).toBeUndefined();
  });

  it('lowers by="id" to <Key> with needsImport', () => {
    const file = parseMx(
      `const el = <for|it, i| of=xs() by="id"><li>x</li></for>;`,
    );
    const els = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: {
          name: { name: string };
          value: { expression: { type: string; value: unknown } };
        }[];
      };
      extra?: { mx?: { needsImport?: string[] } };
    }[];
    const keyEl = els[0] as (typeof els)[number];
    expect(keyEl.openingElement.name.name).toBe("Key");
    const by = keyEl.openingElement.attributes.find(
      (a) => a.name.name === "by",
    );
    expect(by?.value.expression.type).toBe("StringLiteral");
    expect(by?.value.expression.value).toBe("id");
    expect(keyEl.extra?.mx?.needsImport).toEqual(["Key"]);
  });

  it("lowers by=(x => x.id) to <Key> with a function by", () => {
    const file = parseMx(
      `const el = <for|it, i| of=xs() by=(x => x.id)><li>x</li></for>;`,
    );
    const els = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: {
          name: { name: string };
          value: { expression: { type: string } };
        }[];
      };
    }[];
    const keyEl = els[0] as (typeof els)[number];
    expect(keyEl.openingElement.name.name).toBe("Key");
    const by = keyEl.openingElement.attributes.find(
      (a) => a.name.name === "by",
    );
    expect(by?.value.expression.type).toBe("ArrowFunctionExpression");
  });

  it("lowers from/to to Index with mxRange, needsImport", () => {
    const file = parseMx(`const el = <for|i| from=0 to=n()><li>x</li></for>;`);
    const els = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: {
          name: { name: string };
          value: {
            expression: {
              type: string;
              callee?: { name: string };
              arguments?: unknown[];
            };
          };
        }[];
      };
      extra?: { mx?: { needsImport?: string[] } };
    }[];
    const indexEl = els[0] as (typeof els)[number];
    expect(indexEl.openingElement.name.name).toBe("Index");
    const each = indexEl.openingElement.attributes.find(
      (a) => a.name.name === "each",
    );
    expect(each?.value.expression.type).toBe("CallExpression");
    expect(each?.value.expression.callee?.name).toBe("mxRange");
    expect(each?.value.expression.arguments).toHaveLength(4);
    expect(indexEl.extra?.mx?.needsImport).toEqual(["mxRange"]);
  });

  it("lowers in=obj() to Key over Object.entries, needsImport", () => {
    const file = parseMx(`const el = <for|k, v| in=obj()><li>x</li></for>;`);
    const els = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: {
          name: { name: string };
          value: {
            expression: {
              type: string;
              callee?: {
                object?: { name: string };
                property?: { name: string };
              };
            };
          };
        }[];
      };
      children: { expression?: { params: { type: string }[] } }[];
      extra?: { mx?: { needsImport?: string[] } };
    }[];
    const keyEl = els[0] as (typeof els)[number];
    expect(keyEl.openingElement.name.name).toBe("Key");
    const each = keyEl.openingElement.attributes.find(
      (a) => a.name.name === "each",
    );
    expect(each?.value.expression.type).toBe("CallExpression");
    expect(each?.value.expression.callee?.object?.name).toBe("Object");
    expect(each?.value.expression.callee?.property?.name).toBe("entries");
    expect(keyEl.children[0]?.expression?.params[0]?.type).toBe("ArrayPattern");
    expect(keyEl.extra?.mx?.needsImport).toEqual(["Key"]);
  });

  it("wraps a multi-child for body in a fragment", () => {
    const code = printFirstExpression(
      `const el = <for|it| of=xs()><p>A</p><p>B</p></for>;`,
    );
    expect(code).toContain("<>");
  });

  it("passes a single-child for body bare", () => {
    const code = printFirstExpression(
      `const el = <for|it| of=xs()><li>x</li></for>;`,
    );
    expect(code).not.toContain("<>");
  });

  it("rejects <for> with no tag params", () => {
    const err = parseError(`const el = <for of=xs()><li>x</li></for>;`);
    expect(err.message).toContain("tag params");
  });

  it("rejects <for of= in=>", () => {
    const err = parseError(
      `const el = <for|a| of=xs() in=obj()><li>x</li></for>;`,
    );
    expect(err.message).toContain("<for>");
  });
});

describe("fragment", () => {
  it("lowers <fragment> to a JSXFragment", () => {
    const file = parseMx(`const el = <fragment><p>A</p><p>B</p></fragment>;`);
    const fragments = collect(file, "JSXFragment");
    expect(fragments).toHaveLength(1);
  });
});
