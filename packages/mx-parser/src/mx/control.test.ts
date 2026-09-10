import type { PluginObj, TransformOptions } from "@babel/core";
import { transformSync } from "@babel/core";
import generate from "@babel/generator";
import type { Expression } from "@babel/types";
import solidBabelPlugin from "@solidjs/babel-plugin";
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

/**
 * Compiles a `.solid.mx` source all the way through `@solidjs/babel-plugin`,
 * the same `parserOverride` mechanism `packages/oracle/src/compile.ts` uses.
 * A lowering bug that produces a structurally-valid-looking but semantically
 * wrong AST (e.g. a bare `JSXText` where an expression is required) often
 * only surfaces here — `@babel/generator` prints such nodes without
 * complaint, but the Solid transform throws or silently miscompiles them.
 */
function compilesThroughSolid(source: string): string {
  // Two passes, mirroring `packages/oracle/src/compile.ts`: `parserOverride`
  // replaces the *parse* step, so the MX AST has to be printed back to JSX
  // text in its own pass before the Solid plugin re-parses it. Running the
  // override and the Solid plugin in one pass fails — the override returns an
  // AST the Solid plugin's own JSX syntax handling never sees.
  const overridePlugin = {
    name: "mx-control-test-parser-override",
    parserOverride(code: string) {
      return parse(code, "test.solid.mx");
    },
  } as unknown as PluginObj;
  const parsed = transformSync(source, {
    filename: "test.solid.mx",
    plugins: [overridePlugin],
    babelrc: false,
    configFile: false,
  });
  if (!parsed?.code) throw new Error("Babel produced no JSX source");

  const plugins: TransformOptions["plugins"] = [
    [solidBabelPlugin, { generate: "dom", hydratable: false }],
  ];
  const result = transformSync(parsed.code, {
    filename: "test.solid.mx",
    plugins,
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
    it("compiles if/else with plain-text bodies through the Solid compiler without throwing", () => {
      expect(() =>
        compilesThroughSolid(
          `const el = <div><if=c()>hi</if><else>bye</else></div>;`,
        ),
      ).not.toThrow();
    });

    it("compiles a for-body if/else with a placeholder else without throwing", () => {
      expect(() =>
        compilesThroughSolid(
          `const el = <for|t| of=ts()><if=t().done>x</if><else>\${t().text}</else></for>;`,
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

/** The `each`/`keyed`/`count`/`from` attribute of the first lowered element. */
function listAttrs(source: string) {
  const file = parseMx(source);
  const els = collect(file, "JSXElement") as {
    openingElement: {
      name: { name: string };
      attributes: {
        name: { name: string };
        value: { expression: Record<string, unknown> };
      }[];
    };
    children: { expression?: { params: { type: string }[] } }[];
    extra?: { mx?: Record<string, unknown> };
  }[];
  const el = els[0] as (typeof els)[number];
  return {
    name: el.openingElement.name.name,
    attrNames: el.openingElement.attributes.map((a) => a.name.name),
    attr: (n: string) =>
      el.openingElement.attributes.find((a) => a.name.name === n)?.value
        .expression,
    params: el.children[0]?.expression?.params,
    extra: el.extra,
  };
}

describe("for: Solid 2 list rows", () => {
  it("lowers <for|it,i| of=xs()> to <For each keyed={false}>", () => {
    const list = listAttrs(`const el = <for|it, i| of=xs()><li>x</li></for>;`);
    expect(list.name).toBe("For");
    expect(list.attrNames).toEqual(["each", "keyed"]);
    expect(list.attr("keyed")?.type).toBe("BooleanLiteral");
    expect(list.attr("keyed")?.value).toBe(false);
    expect(list.params).toHaveLength(2);
  });

  it("lowers by=identity to <For> with no keyed prop (identity is the default)", () => {
    const list = listAttrs(
      `const el = <for|it, i| of=xs() by=identity><li>x</li></for>;`,
    );
    expect(list.name).toBe("For");
    expect(list.attrNames).toEqual(["each"]);
  });

  it('lowers by="id" to keyed={(x) => x.id}', () => {
    const list = listAttrs(
      `const el = <for|it, i| of=xs() by="id"><li>x</li></for>;`,
    );
    expect(list.name).toBe("For");
    expect(list.attrNames).toEqual(["each", "keyed"]);
    const keyed = list.attr("keyed") as {
      type: string;
      body: { property: { name: string } };
    };
    expect(keyed.type).toBe("ArrowFunctionExpression");
    expect(keyed.body.property.name).toBe("id");
  });

  it("lowers by=(fn) to keyed={fn}", () => {
    const list = listAttrs(
      `const el = <for|it, i| of=xs() by=(x => x.id)><li>x</li></for>;`,
    );
    expect(list.name).toBe("For");
    expect(list.attr("keyed")?.type).toBe("ArrowFunctionExpression");
  });

  it("lowers in=obj() to <For each={Object.entries(obj())} keyed={(e) => e[0]}>", () => {
    const list = listAttrs(`const el = <for|k, v| in=obj()><li>x</li></for>;`);
    expect(list.name).toBe("For");
    const each = list.attr("each") as {
      type: string;
      callee: { object: { name: string }; property: { name: string } };
    };
    expect(each.type).toBe("CallExpression");
    expect(each.callee.object.name).toBe("Object");
    expect(each.callee.property.name).toBe("entries");
    expect(list.attr("keyed")?.type).toBe("ArrowFunctionExpression");
    expect(list.params?.[0]?.type).toBe("ArrayPattern");
  });

  it("carries no needsImport: both Solid 2 compilers auto-import builtIns", () => {
    for (const source of [
      `const el = <for|it, i| of=xs()><li>x</li></for>;`,
      `const el = <for|it, i| of=xs() by="id"><li>x</li></for>;`,
      `const el = <for|k, v| in=obj()><li>x</li></for>;`,
      `const el = <for|i| from=0 to=n()><li>x</li></for>;`,
    ]) {
      const list = listAttrs(source);
      expect(list.extra?.mx?.needsImport).toBeUndefined();
    }
  });

  it("never emits Index, Key or mxRange", () => {
    for (const source of [
      `const el = <for|it, i| of=xs()><li>x</li></for>;`,
      `const el = <for|it, i| of=xs() by="id"><li>x</li></for>;`,
      `const el = <for|k, v| in=obj()><li>x</li></for>;`,
      `const el = <for|i| from=0 to=n()><li>x</li></for>;`,
    ]) {
      const code = printFirstExpression(source);
      expect(code).not.toContain("Index");
      expect(code).not.toContain("Key");
      expect(code).not.toContain("mxRange");
    }
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

describe("for: ranges lower to <Repeat>", () => {
  it("lowers from/to to <Repeat count={(to) - (from) + 1} from={from}>", () => {
    const list = listAttrs(
      `const el = <for|i| from=1 to=n()><li>x</li></for>;`,
    );
    expect(list.name).toBe("Repeat");
    expect(list.attrNames).toEqual(["count", "from"]);
    const count = list.attr("count") as {
      type: string;
      operator: string;
      left: { type: string; operator: string };
      right: { value: number };
    };
    // `(n() - 1) + 1`: a BinaryExpression, not a folded literal, because the
    // upper bound is only known at runtime.
    expect(count.type).toBe("BinaryExpression");
    expect(count.operator).toBe("+");
    expect(count.left.type).toBe("BinaryExpression");
    expect(count.left.operator).toBe("-");
    expect(count.right.value).toBe(1);
  });

  it("lowers until= to count={until - from}, one term shorter", () => {
    const list = listAttrs(
      `const el = <for|i| from=2 until=n()><li>x</li></for>;`,
    );
    expect(list.name).toBe("Repeat");
    const count = list.attr("count") as { type: string; operator: string };
    expect(count.type).toBe("BinaryExpression");
    expect(count.operator).toBe("-");
  });

  it("folds the count when both bounds are numeric literals", () => {
    const inclusive = listAttrs(
      `const el = <for|i| from=1 to=5><li>x</li></for>;`,
    );
    expect(inclusive.attr("count")?.type).toBe("NumericLiteral");
    expect(inclusive.attr("count")?.value).toBe(5);

    const exclusive = listAttrs(
      `const el = <for|i| from=1 until=5><li>x</li></for>;`,
    );
    expect(exclusive.attr("count")?.value).toBe(4);
  });

  it("omits `from` when the author did not write it (Repeat defaults it to 0)", () => {
    const list = listAttrs(`const el = <for|i| until=4><li>x</li></for>;`);
    expect(list.name).toBe("Repeat");
    expect(list.attrNames).toEqual(["count"]);
    expect(list.attr("count")?.value).toBe(4);
  });

  it("gives the range callback one plain-number param", () => {
    const list = listAttrs(`const el = <for|i| to=3><li>x</li></for>;`);
    expect(list.params).toHaveLength(1);
  });

  it("rejects a valueless from= instead of silently defaulting it to 0", () => {
    // `to=`/`until=` already reject these kinds; `from` treating them as 0
    // would compile a wrong range rather than report the mistake.
    const err = parseError(`const el = <for|i| from to=5><li>x</li></for>;`);
    expect(err.message).toContain("`<for from=...>`");
    expect(err.message).toContain("requires an expression value");
  });

  it("rejects an attr-method from=", () => {
    const err = parseError(
      `const el = <for|i| from(a) { b() } to=5><li>x</li></for>;`,
    );
    expect(err.message).toContain("requires an expression value");
  });

  it("still defaults an absent from= to 0", () => {
    const list = listAttrs(`const el = <for|i| to=5><li>x</li></for>;`);
    expect(list.name).toBe("Repeat");
    expect(list.attrNames).toEqual(["count"]);
    expect(list.attr("count")?.value).toBe(6);
  });

  it("rejects step= with a fix-it to a computed array", () => {
    const err = parseError(
      `const el = <for|i| from=0 to=9 step=2><li>x</li></for>;`,
    );
    expect(err.message).toContain("step is not supported");
    expect(err.message).toContain("computed array");
  });

  it("rejects both to= and until= together instead of silently dropping until=", () => {
    const err = parseError(
      `const el = <for|i| from=0 to=5 until=9><li>x</li></for>;`,
    );
    expect(err.message).toContain("to=");
    expect(err.message).toContain("until=");
  });

  it("rejects <for> with neither to= nor until=", () => {
    const err = parseError(`const el = <for|i| from=0><li>x</li></for>;`);
    expect(err.message).toContain("to=");
    expect(err.message).toContain("until=");
  });

  it("compiles every list row through the Solid compiler without throwing", () => {
    for (const source of [
      `const el = <for|it, i| of=xs()><li>x</li></for>;`,
      `const el = <for|it, i| of=xs() by=identity><li>x</li></for>;`,
      `const el = <for|it, i| of=xs() by="id"><li>x</li></for>;`,
      `const el = <for|k, v| in=obj()><li>x</li></for>;`,
      `const el = <for|i| from=1 to=n()><li>x</li></for>;`,
      `const el = <for|i| until=4><li>x</li></for>;`,
    ]) {
      expect(() => compilesThroughSolid(source)).not.toThrow();
    }
  });
});

describe("try: Errored / Loading boundaries", () => {
  it("lowers <try> with @catch to <Errored fallback><Loading></Errored>", () => {
    const code = printFirstExpression(
      `const el = <try><p>body</p><@catch|e|><p>failed</p></@catch></try>;`,
    );
    expect(code).toContain("<Errored fallback={");
    expect(code).toContain("<Loading>");
    expect(code).not.toContain("ErrorBoundary");
    expect(code).not.toContain("Suspense");
  });

  it("accepts <@catch|e, reset|>, exposing Errored's second fallback param", () => {
    const file = parseMx(
      `const el = <try><p>b</p><@catch|e, reset|><button onClick=reset>retry</button></@catch></try>;`,
    );
    const els = collect(file, "JSXElement") as {
      openingElement: {
        name: { name: string };
        attributes: {
          name: { name: string };
          value: { expression: { params: unknown[] } };
        }[];
      };
    }[];
    const errored = els.find((e) => e.openingElement.name.name === "Errored");
    expect(errored).toBeTruthy();
    const fallback = errored?.openingElement.attributes.find(
      (a) => a.name.name === "fallback",
    );
    expect(fallback?.value.expression.params).toHaveLength(2);
  });

  it("lowers <@placeholder> to the Loading fallback", () => {
    const code = printFirstExpression(
      `const el = <try><@placeholder><p>loading</p></@placeholder><p>body</p><@catch|e|><p>err</p></@catch></try>;`,
    );
    expect(code).toContain("<Loading fallback={<p>loading</p>}>");
  });

  it("omits the Errored boundary when there is no @catch", () => {
    const code = printFirstExpression(
      `const el = <try><@placeholder><p>l</p></@placeholder><p>body</p></try>;`,
    );
    expect(code).toContain("<Loading");
    expect(code).not.toContain("Errored");
  });

  it("compiles a full <try> through the Solid compiler without throwing", () => {
    expect(() =>
      compilesThroughSolid(
        `const el = <try><@placeholder><p>l</p></@placeholder><p>b</p><@catch|e, reset|><p>e</p></@catch></try>;`,
      ),
    ).not.toThrow();
  });
});

describe("fragment", () => {
  it("lowers <fragment> to a JSXFragment", () => {
    const file = parseMx(`const el = <fragment><p>A</p><p>B</p></fragment>;`);
    const fragments = collect(file, "JSXFragment");
    expect(fragments).toHaveLength(1);
  });
});
