import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";

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

const parseMx = (source: string) => parse(source, "test.solid.mx");

const attrsOf = (source: string) => {
  const file = parseMx(source);
  const element = collect(file, "JSXElement")[0] as {
    openingElement: { attributes: Record<string, unknown>[] };
  };
  return element.openingElement.attributes;
};

function expectSyntaxError(fn: () => void, expected: string) {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SyntaxError);
  expect((error as Error).message).toContain(expected);
}

describe("spread attributes", () => {
  it("lowers `...expr` to a JSXSpreadAttribute", () => {
    const attrs = attrsOf(`const el = <div ...props>x</div>;`);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.type).toBe("JSXSpreadAttribute");
    const argument = attrs[0]?.argument as { type: string; name: string };
    expect(argument.type).toBe("Identifier");
    expect(argument.name).toBe("props");
  });

  it("preserves order relative to other attributes", () => {
    const attrs = attrsOf(`const el = <div a="1" ...rest b="2">x</div>;`);
    expect(attrs.map((a) => a.type)).toEqual([
      "JSXAttribute",
      "JSXSpreadAttribute",
      "JSXAttribute",
    ]);
    expect((attrs[0] as { name: { name: string } }).name.name).toBe("a");
    expect((attrs[2] as { name: { name: string } }).name.name).toBe("b");
  });
});

describe("class shorthand", () => {
  it("lowers `.class.big` to a static class attribute", () => {
    const attrs = attrsOf(`const el = <div.card.big>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; value: string };
    };
    expect(attr.name.name).toBe("class");
    expect(attr.value.type).toBe("StringLiteral");
    expect(attr.value.value).toBe("card big");
  });

  it("merges shorthand with an explicit string class, shorthand first", () => {
    const attrs = attrsOf(`const el = <div.card class="x">y</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as { value: { value: string } };
    expect(attr.value.value).toBe("card x");
  });

  it("is a parse error combined with a non-string class expression", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div.card class=someObj>y</div>;`),
      "combine shorthand with a string class or use class={...}",
    );
  });

  it("is a parse error combined with an object-literal class", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div.card class={a: on()}>y</div>;`),
      "combined with `.class` shorthand",
    );
  });
});

describe("id shorthand", () => {
  it("lowers `#main` to a static id attribute", () => {
    const attrs = attrsOf(`const el = <div#main>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; value: string };
    };
    expect(attr.name.name).toBe("id");
    expect(attr.value.type).toBe("StringLiteral");
    expect(attr.value.value).toBe("main");
  });

  it("is a parse error combined with an explicit id= attribute", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div#main id="other">x</div>;`),
      "`#id` shorthand combined with an explicit `id=` attribute",
    );
  });
});

describe("class={} object routes to classList", () => {
  it("lowers an object-literal class value to classList", () => {
    const attrs = attrsOf(`const el = <div class={a: on(), b: true}>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: {
        type: string;
        expression: { type: string; properties: unknown[] };
      };
    };
    expect(attr.name.name).toBe("classList");
    expect(attr.value.type).toBe("JSXExpressionContainer");
    expect(attr.value.expression.type).toBe("ObjectExpression");
    expect(attr.value.expression.properties).toHaveLength(2);
  });

  it("keeps class=someObj as class={someObj}, not classList", () => {
    const attrs = attrsOf(`const el = <div class=someObj>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; name: string } };
    };
    expect(attr.name.name).toBe("class");
    expect(attr.value.expression.type).toBe("Identifier");
    expect(attr.value.expression.name).toBe("someObj");
  });
});

describe("style={} object container", () => {
  it("wraps an object-literal style value in a double-brace container", () => {
    const attrs = attrsOf(`const el = <div style={color: c()}>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; properties: unknown[] } };
    };
    expect(attr.name.name).toBe("style");
    expect(attr.value.expression.type).toBe("ObjectExpression");
    expect(attr.value.expression.properties).toHaveLength(1);
  });

  it("is a parse error for a non-object style value", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div style=c()>x</div>;`),
      "non-object value",
    );
  });
});

describe("namespaced attributes", () => {
  for (const ns of ["on", "oncapture", "prop", "attr", "bool", "use"]) {
    it(`lowers \`${ns}:name=fn\` to a JSXNamespacedName`, () => {
      const attrs = attrsOf(`const el = <div ${ns}:name=fn>x</div>;`);
      expect(attrs).toHaveLength(1);
      const attr = attrs[0] as {
        name: {
          type: string;
          namespace: { name: string };
          name: { name: string };
        };
      };
      expect(attr.name.type).toBe("JSXNamespacedName");
      expect(attr.name.namespace.name).toBe(ns);
      expect(attr.name.name.name).toBe("name");
    });
  }

  it("lowers the attr-method form on a namespaced name to a block-body arrow", () => {
    const attrs = attrsOf(`const el = <div on:scroll(e) { go(e) }>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: {
        type: string;
        namespace: { name: string };
        name: { name: string };
      };
      value: {
        expression: { type: string; params: unknown[]; body: { type: string } };
      };
    };
    expect(attr.name.type).toBe("JSXNamespacedName");
    expect(attr.name.namespace.name).toBe("on");
    expect(attr.value.expression.type).toBe("ArrowFunctionExpression");
    expect(attr.value.expression.params).toHaveLength(1);
    expect(attr.value.expression.body.type).toBe("BlockStatement");
  });
});

describe("ref", () => {
  it("lowers `ref=el` to `ref={el}`", () => {
    const attrs = attrsOf(`const el = <div ref=target>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; expression: { type: string; name: string } };
    };
    expect(attr.name.name).toBe("ref");
    expect(attr.value.type).toBe("JSXExpressionContainer");
    expect(attr.value.expression.type).toBe("Identifier");
    expect(attr.value.expression.name).toBe("target");
  });

  it("lowers the attr-method form `ref(el) { ... }` to a block-body arrow", () => {
    const attrs = attrsOf(`const el = <div ref(node) { save(node) }>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: {
        expression: { type: string; params: unknown[]; body: { type: string } };
      };
    };
    expect(attr.name.name).toBe("ref");
    expect(attr.value.expression.type).toBe("ArrowFunctionExpression");
    expect(attr.value.expression.params).toHaveLength(1);
    expect(attr.value.expression.body.type).toBe("BlockStatement");
  });
});

describe("data-* and aria-* pass-through", () => {
  it("keeps hyphenated names as a plain JSXIdentifier", () => {
    const attrs = attrsOf(
      `const el = <div data-count=n() aria-label="x">y</div>;`,
    );
    expect(attrs).toHaveLength(2);
    const [dataAttr, ariaAttr] = attrs as {
      name: { type: string; name: string };
    }[];
    expect(dataAttr?.name.type).toBe("JSXIdentifier");
    expect(dataAttr?.name.name).toBe("data-count");
    expect(ariaAttr?.name.type).toBe("JSXIdentifier");
    expect(ariaAttr?.name.name).toBe("aria-label");
  });
});

describe("boolean attribute", () => {
  it("lowers `disabled` to `disabled={true}`", () => {
    const attrs = attrsOf(`const el = <input disabled>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; value: boolean } };
    };
    expect(attr.name.name).toBe("disabled");
    expect(attr.value.expression.type).toBe("BooleanLiteral");
    expect(attr.value.expression.value).toBe(true);
  });
});

describe("static string values keep their original quote style", () => {
  it("keeps double quotes", () => {
    const attrs = attrsOf(`const el = <div title="hi">x</div>;`);
    const attr = attrs[0] as { value: { extra: { raw: string } } };
    expect(attr.value.extra.raw).toBe('"hi"');
  });

  it("keeps single quotes", () => {
    const attrs = attrsOf(`const el = <div title='hi'>x</div>;`);
    const attr = attrs[0] as { value: { extra: { raw: string } } };
    expect(attr.value.extra.raw).toBe("'hi'");
  });
});

describe("raw placeholder ($!{}) as innerHTML", () => {
  it("lowers a sole $!{} child to an innerHTML attribute with no children", () => {
    const file = parseMx(`const el = <div>$!{html}</div>;`);
    const element = collect(file, "JSXElement")[0] as {
      openingElement: { attributes: { name: { name: string } }[] };
      children: unknown[];
    };
    expect(element.children).toHaveLength(0);
    expect(element.openingElement.attributes).toHaveLength(1);
    expect(element.openingElement.attributes[0]?.name.name).toBe("innerHTML");
  });

  it("is a parse error when $!{} is mixed with other children", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div>x$!{html}</div>;`),
      "raw placeholder must be the only child",
    );
  });

  it("allows whitespace and comments alongside the sole raw placeholder", () => {
    const file = parseMx(`const el = <div>\n  <!-- c -->$!{html}\n</div>;`);
    const element = collect(file, "JSXElement")[0] as {
      openingElement: { attributes: { name: { name: string } }[] };
      children: unknown[];
    };
    expect(element.children).toHaveLength(0);
    expect(element.openingElement.attributes[0]?.name.name).toBe("innerHTML");
  });
});
