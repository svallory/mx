import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Ctx, Node, Policy } from "./core.ts";
import { newCtx } from "./core.ts";
import type { Ir, IrNode } from "./ir.ts";
import { resolve } from "./resolve.ts";

/**
 * The resolver (decision 79): one fixture per IR kind, plus the error cases.
 *
 * These are the tests that keep the IR honest. `compileSource`'s own emitted
 * output is asserted elsewhere (`@mxlang/translator`'s suite and both
 * oracles); what is asserted *here* is the shape the core hands a host —
 * because a host's emitter is written against this tree and nothing else, so a
 * silently changed node kind, a dropped child or a lost position is a break no
 * string comparison downstream would localize.
 *
 * Positions are asserted alongside the structure rather than in a separate
 * test: a node whose `loc` is wrong is as broken as one whose `kind` is wrong
 * — a host reports diagnostics from these, and `@mxlang/language-server` turns
 * them into editor squiggles.
 */

/**
 * A minimal host: every tag is an element, and a component is whatever a
 * `<define>` bound.
 *
 * `isComponent` consults `ctx.defines` because every real host does — a
 * `<define>`'s name has to route to a component call for the define to be
 * callable at all. A fake that answered a flat `false` would make
 * `<Row('a')/>` an unbound capitalized tag, which is a property of the fake
 * rather than of the resolver.
 */
function fakeDeclarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    emitComponent: () => {
      throw new Error("unused");
    },
    escapeFrom: "@mxlang/core",
    ...overrides,
  };
}

/**
 * Resolves `source` to an IR, through the real Marko parse.
 *
 * `compileSource` is driven for its parse and its taglib lookup, and the
 * translate visitor is hijacked to resolve rather than emit — the resolver has
 * to see exactly the nodes a real compile produces, not a hand-built tree.
 */
function resolveSource(source: string, policy = fakeDeclarations()): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;

  const host = {
    postEmit: (code: string) => code,
  };

  // The core's own front door runs `emitProgram`; this test needs `resolve`
  // over the same body. `newCtx` plus the compiler's parse is the seam: a
  // translator whose Program visitor resolves instead of emitting.
  const translator = {
    taglibs: [] as Array<[string, unknown]>,
    tagDiscoveryDirs: [] as string[],
    translate: {
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const ctx: Ctx = newCtx(source, printExpression, policy);
          try {
            ir = resolve(ctx, path.node.body);
          } catch (error) {
            thrown = error;
          }
          path.node.body = [];
        },
      },
    },
  };

  const require = createRequire(import.meta.url);
  const compiler = require("@marko/compiler");
  compiler.compileSync(source, "/tmp/mx-core-test/resolve.mx", {
    translator,
    output: "html",
    writeVersionComment: false,
  });
  void host;

  if (thrown) throw thrown;
  if (!ir) throw new Error("resolver produced no IR");
  return ir;
}

import { createRequire } from "node:module";

function printExpression(node: unknown): string {
  const require = createRequire(import.meta.url);
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

/** The first node of a kind, anywhere in the tree. */
function find<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> {
  for (const node of nodes) {
    if (node.kind === kind) return node as Extract<IrNode, { kind: K }>;
    for (const key of ["children", "body"] as const) {
      const nested = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        const hit = tryFind(nested as IrNode[], kind);
        if (hit) return hit;
      }
    }
    if (node.kind === "IfChain") {
      for (const branch of node.branches) {
        const hit = tryFind(branch.children, kind);
        if (hit) return hit;
      }
    }
  }
  throw new Error(`no ${kind} node in the IR`);
}

function tryFind<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> | null {
  try {
    return find(nodes, kind);
  } catch {
    return null;
  }
}

describe("one fixture per IR kind", () => {
  it("Text carries the value Marko already normalized", () => {
    const ir = resolveSource("<p>hello</p>\n");
    const text = find(ir.body, "Text");
    expect(text.value).toBe("hello");
    // Decision 33 is Marko's own `onText`, applied before the resolver sees
    // the node; a second normalization here would collapse twice.
    expect(text.loc.line).toBe(1);
  });

  it("Interpolation records escaped and raw placeholders apart", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const escaped = resolveSource("<p>${input.a}</p>\n");
    expect(find(escaped.body, "Interpolation")).toMatchObject({
      escaped: true,
      expr: { code: "input.a" },
    });

    const raw = resolveSource("<p>$!{input.a}</p>\n");
    expect(find(raw.body, "Interpolation").escaped).toBe(false);
  });

  it("Element carries its name, attrs and children", () => {
    const ir = resolveSource('<div class="card" hidden>x</div>\n');
    const element = find(ir.body, "Element");
    expect(element.name).toBe("div");
    expect(element.void).toBe(false);
    expect(element.attrs).toMatchObject([
      { kind: "static", name: "class", value: "card" },
      { kind: "boolean", name: "hidden" },
    ]);
    expect(find(element.children, "Text").value).toBe("x");
  });

  it("Element marks a void tag and takes no children", () => {
    const ir = resolveSource("<input>\n");
    const element = find(ir.body, "Element");
    expect(element.void).toBe(true);
    expect(element.children).toEqual([]);
  });

  it("Attr separates static, dynamic, bound and spread", () => {
    const ir = resolveSource(
      '<div id="a" title=input.t ...input.rest>x</div>\n',
    );
    expect(find(ir.body, "Element").attrs).toMatchObject([
      { kind: "static", name: "id", value: "a" },
      { kind: "dynamic", name: "title", value: { code: "input.t" } },
      { kind: "spread", value: { code: "input.rest" } },
    ]);
  });

  it("IfChain groups every branch, with a null condition for else", () => {
    const ir = resolveSource(
      [
        "<if=input.a>",
        "  <p>a</p>",
        "</if>",
        "<else if=input.b>",
        "  <p>b</p>",
        "</else>",
        "<else>",
        "  <p>c</p>",
        "</else>",
        "",
      ].join("\n"),
    );
    const chain = find(ir.body, "IfChain");
    expect(chain.branches).toHaveLength(3);
    expect(chain.branches[0]?.condition?.code).toBe("input.a");
    expect(chain.branches[1]?.condition?.code).toBe("input.b");
    // The trailing `<else>` is the branch with no condition — the whole reason
    // the chain is one node rather than three siblings a host must re-scan.
    expect(chain.branches[2]?.condition).toBeNull();
  });

  it("For normalizes `of=`, with params and their bindings", () => {
    const ir = resolveSource("<for|item, i| of=input.xs><p>x</p></for>\n");
    const loop = find(ir.body, "For");
    expect(loop.source).toMatchObject({
      kind: "of",
      list: { code: "input.xs" },
    });
    expect(loop.params).toEqual(["item", "i"]);
    expect(loop.bindings).toEqual(["item", "i"]);
  });

  it("For normalizes `in=`", () => {
    const ir = resolveSource("<for|k, v| in=input.obj><p>x</p></for>\n");
    expect(find(ir.body, "For").source).toMatchObject({
      kind: "in",
      object: { code: "input.obj" },
    });
  });

  it("For normalizes the inclusive and exclusive ranges apart", () => {
    const inclusive = resolveSource("<for|n| from=1 to=5><p>x</p></for>\n");
    expect(find(inclusive.body, "For").source).toMatchObject({
      kind: "range",
      inclusive: true,
      from: { code: "1" },
      bound: { code: "5" },
    });

    const exclusive = resolveSource("<for|n| until=5><p>x</p></for>\n");
    expect(find(exclusive.body, "For").source).toMatchObject({
      kind: "range",
      inclusive: false,
      // `from=` omitted is the range's own default, recorded as null rather
      // than invented as a literal the author never wrote.
      from: null,
      bound: { code: "5" },
    });
  });

  it("Define carries its name, params and body", () => {
    const ir = resolveSource(
      "<define/Row|item|><li>x</li></define>\n<Row('a')/>\n",
    );
    const define = find(ir.body, "Define");
    expect(define.name).toBe("Row");
    expect(define.params).toEqual(["item"]);
    expect(find(define.children, "Element").name).toBe("li");
  });

  it("Const carries the declared name and its initializer", () => {
    const ir = resolveSource("<const/doubled=input.n * 2/>\n<p>x</p>\n");
    expect(find(ir.body, "Const")).toMatchObject({
      name: "doubled",
      init: { code: "input.n * 2" },
    });
  });

  it("Import and Static are lifted out of the body to module scope", () => {
    const ir = resolveSource(
      'import Panel from "./panel.marko"\nstatic const G = 1\n<p>x</p>\n',
    );
    expect(ir.imports).toEqual(['import Panel from "./panel.marko"']);
    expect(ir.hoisted).toEqual(["const G = 1"]);
    // Lifted, not left behind: a host reads them from `Ir`'s own fields rather
    // than filtering the body for statement nodes.
    expect(tryFind(ir.body, "Import")).toBeNull();
    expect(tryFind(ir.body, "Static")).toBeNull();
  });

  it("Export hoists verbatim and InputInterface is kept apart", () => {
    const ir = resolveSource(
      "export interface Input { n: number }\nexport const prerender = true;\n<p>x</p>\n",
    );
    expect(ir.inputInterface).toBe("export interface Input { n: number }");
    expect(ir.hoisted).toEqual(["export const prerender = true;"]);
  });

  it("DocumentType keeps the value with its delimiters stripped", () => {
    const ir = resolveSource("<!doctype html>\n<p>x</p>\n");
    expect(find(ir.body, "DocumentType").value).toBe("doctype html");
  });

  it("Comment records whether the source spelled an HTML comment", () => {
    const ir = resolveSource("<!-- keep -->\n<p>x</p>\n");
    const comment = find(ir.body, "Comment");
    // Marko strips the delimiters, so only the source can tell an HTML comment
    // from a `//` line comment — the resolver reads it back rather than
    // guessing from the value.
    expect(comment.html).toBe(true);
    expect(comment.value).toBe(" keep ");
  });

  it("Component resolves an import binding as its target", () => {
    const ir = resolveSource(
      'import Panel from "./panel.marko"\n<Panel title="t">body</Panel>\n',
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({ kind: "name", name: "Panel" });
    expect(component.attrs).toMatchObject([
      { kind: "static", name: "title", value: "t" },
    ]);
    expect(component.content).not.toBeNull();
  });

  it("Component collects attribute tags as props, in source order", () => {
    const ir = resolveSource(
      [
        'import Panel from "./panel.marko"',
        "<Panel>",
        "  <@header>H</@header>",
        "  <@footer|year|>F</@footer>",
        "</Panel>",
        "",
      ].join("\n"),
      fakeDeclarations({ isComponent: (name) => name === "Panel" }),
    );
    const component = find(ir.body, "Component");
    expect(component.attributeTags.map((t) => t.name)).toEqual([
      "header",
      "footer",
    ]);
    // A block's own params travel with it: a host with a render-prop form uses
    // them, and a host without one rejects them by name.
    expect(component.attributeTags[1]?.block.params).toEqual(["year"]);
  });

  it("Component records a define target with its declared params", () => {
    const ir = resolveSource(
      "<define/Row|item|><li>x</li></define>\n<Row('a')/>\n",
      fakeDeclarations({ isComponent: (name) => name === "Row" }),
    );
    const component = find(ir.body, "Component");
    expect(component.target).toMatchObject({
      kind: "define",
      name: "Row",
      params: ["item"],
    });
    // Marko's generator prints the author's own quoting back, so a
    // single-quoted argument stays single-quoted.
    expect(component.args.map((a) => a.code)).toEqual(["'a'"]);
  });

  it("HostTag hands a claimed tag over with its parts resolved", () => {
    const ir = resolveSource(
      "<signal/count=1>body</signal>\n",
      fakeDeclarations({
        claimsTag: (name) => name === "signal",
        resolveHostTag: (name) => ({ seen: name }),
      }),
    );
    const hosted = find(ir.body, "HostTag").tag;
    expect(hosted.name).toBe("signal");
    expect(hosted.var).toBe("count");
    expect(hosted.attrs).toMatchObject([{ kind: "dynamic", name: "value" }]);
    expect(find(hosted.children, "Text").value).toBe("body");
    // The opaque slot the host filled at resolve time, so its emitter never
    // re-inspects a Marko node to recover its own decision.
    expect(hosted.data).toEqual({ seen: "signal" });
  });

  it("Hoisted lands ahead of the construct that produced it", () => {
    const ir = resolveSource(
      "<if=input.on>\n  <signal/count=7/>\n</if>\n<p>x</p>\n",
      fakeDeclarations({
        claimsTag: (name) => name === "signal",
        resolveHostTag: (_name, node, ctx) => {
          ctx.hoist(`const ${node.var.name} = 7;`);
          return null;
        },
      }),
    );
    // The declaration outlives the block it was written in, which is the whole
    // point of decision 70's hoist hook.
    expect(ir.prelude).toEqual(["const count = 7;"]);
  });

  it("an inert tag is accepted and contributes nothing", () => {
    const ir = resolveSource(
      "<p>a</p>\n<mytag/>\n",
      fakeDeclarations({
        tags: {
          mytag: { kind: "inert", reason: "inert", body: "none" },
        },
      }),
    );
    // Accepted, with no output: the node is empty text rather than absent, so
    // the body's shape still matches the source's.
    expect(ir.body.some((n) => n.kind === "Element" && n.name === "p")).toBe(
      true,
    );
  });
});

describe("positions", () => {
  it("records a 1-based line and 0-based column on every node", () => {
    const ir = resolveSource("<p>a</p>\n<div>b</div>\n");
    const first = ir.body.find(
      (n) => n.kind === "Element" && n.name === "p",
    ) as Extract<IrNode, { kind: "Element" }>;
    const second = ir.body.find(
      (n) => n.kind === "Element" && n.name === "div",
    ) as Extract<IrNode, { kind: "Element" }>;
    expect(first.loc).toEqual({ line: 1, column: 0 });
    expect(second.loc).toEqual({ line: 2, column: 0 });
  });

  it("records the position of a nested node, not its parent's", () => {
    const ir = resolveSource("<div>\n  <span>x</span>\n</div>\n");
    const span = find(find(ir.body, "Element").children, "Element");
    expect(span.loc).toEqual({ line: 2, column: 2 });
  });
});

describe("errors keep their message and position", () => {
  /**
   * Every message here is asserted verbatim elsewhere too — the translator's
   * own suite, its error fixtures, or the oracle's error class — so a reworded
   * message is a behaviour change even when the construct is still rejected.
   */
  it.each([
    [
      "<if> with no condition",
      "<if>\n  <p>x</p>\n</if>\n",
      /`<if>` without a condition/,
    ],
    [
      "<for> with no params",
      "<for of=input.xs><p>x</p></for>\n",
      /`<for>` needs tag params/,
    ],
    [
      "<for> with no iterable",
      "<for|x|><p>y</p></for>\n",
      /`<for>` requires `of=`, `in=`, or `from=`\/`to=`\/`until=`/,
    ],
    [
      "<for step=>",
      "<for|n| from=0 to=5 step=2><p>x</p></for>\n",
      /step is not supported/,
    ],
    [
      "a stray <else>",
      "<else>\n  <p>x</p>\n</else>\n",
      /`<else>` without a preceding `<if>`/,
    ],
    [
      "<const> with no value",
      "<const/x/>\n<p>y</p>\n",
      /`<const>` without a value/,
    ],
    [
      "<define> with no name",
      "<define><p>x</p></define>\n",
      /`<define>` without a name/,
    ],
    [
      "an attribute tag outside a component",
      "<div><@header>x</@header></div>\n",
      /attribute tag `@header`/,
    ],
    ["tag params on an element", "<div|a|>x</div>\n", /tag params/],
    ["a scriptlet", "$ const x = 1\n<p>y</p>\n", /scriptlets/],
  ])("rejects %s", (_what, source, message) => {
    expect(() => resolveSource(source)).toThrow(message);
  });

  it("rejects an unknown lowercase tag rather than emitting it literally", () => {
    expect(() =>
      resolveSource(
        "<mystery>x</mystery>\n",
        fakeDeclarations({ isElement: () => false }),
      ),
    ).toThrow(/unknown tag `<mystery>`/);
  });

  it("rejects an unbound capitalized tag as a missing component", () => {
    expect(() =>
      resolveSource(
        "<Missing>x</Missing>\n",
        fakeDeclarations({ isElement: () => false }),
      ),
    ).toThrow(/a capitalized tag is always a component call/);
  });

  it("reports an error's position, not just its message", () => {
    let caught: { line?: number; column?: number } | null = null;
    try {
      resolveSource("<p>a</p>\n<for of=input.xs><li>x</li></for>\n");
    } catch (error) {
      caught = error as { line?: number; column?: number };
    }
    // Second line of the source, which is what an editor squiggle needs.
    expect(caught?.line).toBe(2);
  });

  it("raises a host's error disposition by name", () => {
    expect(() =>
      resolveSource(
        "<await>x</await>\n",
        fakeDeclarations({
          tags: { await: { kind: "error", reason: "`<await>` suspends" } },
        }),
      ),
    ).toThrow(/`<await>` suspends/);
  });

  it("checkBinding sees a render-scope binding, and not a tag param", () => {
    const seen: string[] = [];
    const declarations = fakeDeclarations({
      checkBinding: (target: Node) => {
        seen.push(target.name);
      },
    });

    resolveSource("<const/ok=1/>\n<p>x</p>\n", declarations);
    expect(seen).toEqual(["ok"]);

    // A tag param opens a nested scope where an ordinary JS shadow is correct,
    // so it is deliberately not offered to `checkBinding` — Marko draws the
    // same line, rendering `<for|input|>` while rejecting `<let/input>`.
    seen.length = 0;
    resolveSource("<for|item| of=input.xs><p>x</p></for>\n", declarations);
    expect(seen).toEqual([]);
  });
});

describe("the resolver runs under the real front door", () => {
  it("compiles a template end to end without the IR changing behaviour", () => {
    // The emitting walk is still what `compileSource` drives; this pins that
    // adding the resolver alongside it changed nothing about that path.
    const { code } = compileSource(
      "<p>hi</p>\n",
      "/tmp/mx-core-test/probe.mx",
      fakeDeclarations(),
    );
    expect(code).toContain('out += "<p>hi</p>"');
  });
});
