import type { PluginObj, TransformOptions } from "@babel/core";
import { transformSync } from "@babel/core";
import generate from "@babel/generator";
import solidPreset from "babel-preset-solid";
import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";

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

/**
 * Compiles a `.solid.mx` source all the way through `babel-preset-solid`, the
 * same `parserOverride` mechanism `packages/oracle/src/compile.ts` uses. A
 * lowering bug that produces a structurally-valid-looking but semantically
 * wrong AST (e.g. a bare `JSXText` where an expression is required) often
 * only surfaces here — `@babel/generator` prints such nodes without
 * complaint, but the Solid transform throws or silently miscompiles them.
 */
function compilesThroughSolid(source: string): string {
  const overridePlugin = {
    name: "mx-control-test-parser-override",
    parserOverride(code: string) {
      return parse(code, "test.solid.mx");
    },
  } as unknown as PluginObj;
  const presets: TransformOptions["presets"] = [
    [solidPreset, { generate: "dom", hydratable: false }],
  ];
  const result = transformSync(source, {
    filename: "test.solid.mx",
    presets,
    plugins: [overridePlugin],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error("Babel produced no output");
  return result.code;
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
    // A lone JSXText child ("A") is not valid in expression position, so a
    // single-text body wraps in a fragment even though there's only one child.
    const code = printFirstExpression(`const el = <if=cond()>A</if>;`);
    expect(code).toBe("<Show when={cond()}><>A</></Show>");
  });

  it("lowers if/else to Show with a fallback", () => {
    const code = printFirstExpression(
      `const el = <div><if=cond()>A</if><else>B</else></div>;`,
    );
    expect(code).toContain(
      "<Show when={cond()} fallback={<>B</>}><>A</></Show>",
    );
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
    expect(code).toContain("fallback={<>B</>}");
  });

  it("starts the nested Show (single else-if) at the <else if> tag, not the outer <if>", () => {
    const source = `const el = <div><if=a()>A</if><else if=b()>B</else><else>C</else></div>;`;
    const file = parseMx(source);
    const shows = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
      start: number;
    }[];
    const showNodes = shows.filter(
      (s) => s.openingElement.name.name === "Show",
    );
    expect(showNodes).toHaveLength(2);
    const elseIfTagStart = source.indexOf("<else if=b()>");
    const starts = showNodes.map((s) => s.start).sort((a, b) => a - b);
    // The outer Show starts at the <if>; the inner (synthesized) Show starts
    // at the <else if> tag it was built from, not before it.
    expect(starts[1]).toBe(elseIfTagStart);
  });

  describe("round 2: bodies used in expression position (review)", () => {
    it("compiles if/else with plain-text bodies through babel-preset-solid without throwing", () => {
      expect(() =>
        compilesThroughSolid(
          `const el = <div><if=c()>hi</if><else>bye</else></div>;`,
        ),
      ).not.toThrow();
    });

    it("compiles a for-body if/else with a placeholder else through babel-preset-solid without throwing", () => {
      expect(() =>
        compilesThroughSolid(
          `const el = <for|t| of=ts()><if=t.done>x</if><else>\${t.text}</else></for>;`,
        ),
      ).not.toThrow();
    });

    it("does not turn a for body's plain text into an identifier reference", () => {
      const code = compilesThroughSolid(`const el = <for|x| of=xs()>hi</for>;`);
      // Before the fix this compiled silently to `children: x => hi` — `hi`
      // read as an identifier reference rather than rendered text.
      expect(code).not.toMatch(/=>\s*hi\b/);
    });
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

  describe("round 2: from/to/until (review)", () => {
    it("rejects both to= and until= together instead of silently dropping until=", () => {
      const err = parseError(
        `const el = <for|i| from=0 to=5 until=9><li>x</li></for>;`,
      );
      expect(err.message).toContain("to=");
      expect(err.message).toContain("until=");
    });

    it("defaults from= to 0 for until= just as it does for to=", () => {
      const file = parseMx(`const el = <for|i| until=5><li>x</li></for>;`);
      const els = collect(file, "JSXElement") as {
        openingElement: {
          attributes: {
            name: { name: string };
            value: {
              expression: { type: string; arguments?: { value?: number }[] };
            };
          }[];
        };
      }[];
      const each = els[0]?.openingElement.attributes.find(
        (a) => a.name.name === "each",
      );
      expect(each?.value.expression.type).toBe("CallExpression");
      expect(each?.value.expression.arguments?.[0]?.value).toBe(0);
    });

    it("accepts <for|i| to=5> without from=, defaulting it to 0", () => {
      expect(() =>
        parseMx(`const el = <for|i| to=5><li>x</li></for>;`),
      ).not.toThrow();
    });

    it("rejects <for> with neither to= nor until=", () => {
      const err = parseError(`const el = <for|i| from=0><li>x</li></for>;`);
      expect(err.message).toContain("to=");
      expect(err.message).toContain("until=");
    });
  });
});

describe("fragment", () => {
  it("lowers <fragment> to a JSXFragment", () => {
    const file = parseMx(`const el = <fragment><p>A</p><p>B</p></fragment>;`);
    const fragments = collect(file, "JSXFragment");
    expect(fragments).toHaveLength(1);
  });
});
