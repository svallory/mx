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

describe("MX element parsing", () => {
  it("lowers an attr method to a block-body arrow", () => {
    const file = parseMx(
      `const el = <button onClick() { setCount(count() + 1) }>\${count()}</button>;`,
    );
    const arrows = collect(file, "ArrowFunctionExpression") as {
      body: { type: string; body: unknown[] };
      params: unknown[];
      async: boolean;
    }[];
    expect(arrows).toHaveLength(1);
    // The block body is never unwrapped to an expression body, even though it
    // holds a single expression statement.
    expect(arrows[0]?.body.type).toBe("BlockStatement");
    expect(arrows[0]?.body.body).toHaveLength(1);
    expect(arrows[0]?.params).toHaveLength(0);
    expect(arrows[0]?.async).toBe(false);
  });

  it("lowers static, dynamic and boolean attributes", () => {
    const file = parseMx(`const el = <a href="/x" title=t() disabled>go</a>;`);
    const attrs = collect(file, "JSXAttribute") as {
      name: { name: string };
      value: { type: string; expression?: { type: string; value?: unknown } };
    }[];
    expect(attrs.map((a) => a.name.name)).toEqual([
      "href",
      "title",
      "disabled",
    ]);
    expect(attrs[0]?.value.type).toBe("StringLiteral");
    expect(attrs[1]?.value.type).toBe("JSXExpressionContainer");
    expect(attrs[1]?.value.expression?.type).toBe("CallExpression");
    expect(attrs[2]?.value.expression?.type).toBe("BooleanLiteral");
    expect(attrs[2]?.value.expression?.value).toBe(true);
  });

  it("lowers a placeholder to an expression container", () => {
    const file = parseMx(`const el = <p>\${count()}</p>;`);
    const containers = collect(file, "JSXExpressionContainer");
    expect(containers).toHaveLength(1);
  });

  it("produces only standard Babel node types", () => {
    const file = parseMx(
      `const el = <button onClick() { go() }>hi \${x()}</button>;`,
    );
    const seen = new Set<string>();
    const visit = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.type === "string") seen.add(record.type);
      for (const key of Object.keys(record)) {
        if (key === "loc") continue;
        visit(record[key]);
      }
    };
    visit(file.program);
    for (const type of seen) {
      expect(type.startsWith("Mx")).toBe(false);
    }
    expect(seen.has("JSXElement")).toBe(true);
  });

  // --- criterion 8 safety cases ---

  it("(a) parses a TS generic arrow followed by an MX element", () => {
    const file = parseMx(`const id = <T,>(x: T) => x;\nconst el = <p>hi</p>;`);
    const arrows = collect(file, "ArrowFunctionExpression") as {
      typeParameters?: unknown;
    }[];
    // The `<T,>` must stay a generic arrow, not become an element.
    expect(arrows).toHaveLength(1);
    expect(arrows[0]?.typeParameters).toBeTruthy();
    expect(collect(file, "JSXElement")).toHaveLength(1);
  });

  it("(b) reports an unterminated MX tag as a positioned SyntaxError", () => {
    let error: unknown;
    try {
      parseMx(`const el = <button>oops;\n`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    const err = error as SyntaxError & {
      loc?: { line: number; index: number };
    };
    // A Babel error with a position inside the file, not an htmljs-parser
    // stack trace.
    expect(err.loc).toBeTruthy();
    expect(err.loc?.line).toBe(1);
    expect(err.stack).not.toContain("htmljs-parser");
  });

  it("(c) parses MX nested inside an attr method body", () => {
    const file = parseMx(
      `const el = <div onClick() { render(<span>x</span>) }>y</div>;`,
    );
    const elements = collect(file, "JSXElement") as {
      openingElement: { name: { name: string } };
    }[];
    expect(elements.map((e) => e.openingElement.name.name).sort()).toEqual([
      "div",
      "span",
    ]);
  });

  it("(d) parses two consecutive MX expressions with correct locations", () => {
    const source = `const a = <p>1</p>; const b = <p>2</p>;`;
    const file = parseMx(source);
    const elements = collect(file, "JSXElement") as {
      start: number;
      end: number;
      loc: { start: { column: number } };
    }[];
    expect(elements).toHaveLength(2);
    expect(source.slice(elements[0]?.start, elements[0]?.end)).toBe("<p>1</p>");
    // The second element's position must be right, which is what proves the
    // tokenizer was repositioned correctly after the first one closed.
    expect(source.slice(elements[1]?.start, elements[1]?.end)).toBe("<p>2</p>");
    expect(elements[1]?.loc.start.column).toBe(source.indexOf("<p>2"));
  });

  it("keeps locations correct across newlines", () => {
    const source = `const el = (\n  <div>\n    <span>x</span>\n  </div>\n);\nconst after = 1;\n`;
    const file = parseMx(source);
    const after = collect(file, "VariableDeclaration") as {
      loc: { start: { line: number } };
    }[];
    // `const after = 1;` is on line 6; getting there requires curLine and
    // lineStart to have been recomputed over the consumed MX region.
    expect(after[1]?.loc.start.line).toBe(6);
  });
});

describe("unsupported constructs raise a clear error", () => {
  const cases: [string, string, string][] = [
    ["<if>", `const el = <if=cond()>x</if>;`, "`<if>`"],
    ["<for>", `const el = <for|a| of=xs()>x</for>;`, "`<for>`"],
    [
      "attribute tag",
      `const el = <L><@header>x</@header></L>;`,
      "attribute tag",
    ],
    ["class shorthand", `const el = <div.card>x</div>;`, "`.class` shorthand"],
    ["spread", `const el = <div ...props>x</div>;`, "spread attribute"],
    [
      "namespaced attr",
      `const el = <div on:scroll=fn>x</div>;`,
      "namespaced attribute",
    ],
    ["unescaped placeholder", `const el = <p>$!{raw}</p>;`, "$!{...}"],
  ];

  for (const [name, source, expected] of cases) {
    it(`rejects ${name}`, () => {
      let error: unknown;
      try {
        parse(source, "test.solid.mx");
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SyntaxError);
      expect((error as Error).message).toContain(expected);
    });
  }
});
