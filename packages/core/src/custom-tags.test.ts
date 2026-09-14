import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Ctx, Node } from "./core.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { CustomTagCall, CustomTagDefinition } from "./custom-tags.ts";
import { MAX_EXPANSION_DEPTH, MAX_EXPANSION_NODES } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { resolve } from "./resolve.ts";

/**
 * Custom Tags (decision 85), against the real Marko parse.
 *
 * Same shape as `resolve.test.ts`: what is asserted is the IR a host receives,
 * because a host emitter is written against that tree and nothing else. The
 * central claim under test is that a custom tag contributes *ordinary* IR —
 * nothing a host has to learn about — and that author-written material inside
 * the expansion keeps its real positions.
 */

const require = createRequire(import.meta.url);

function printExpression(node: unknown): string {
  const { generator } = require("@marko/compiler/internal/babel");
  return generator(node, { concise: true }).code;
}

function fakeDeclarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

function resolveWithTags(
  source: string,
  customTags: Record<string, CustomTagDefinition>,
  policy = fakeDeclarations(),
): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;

  const translator = {
    taglibs: [] as Array<[string, unknown]>,
    tagDiscoveryDirs: [] as string[],
    translate: {
      // biome-ignore lint/style/useNamingConvention: a Marko translate visitor key is a node type
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const ctx: Ctx = newCtx(source, printExpression, policy);
          ctx.customTags = customTags;
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

  const compiler = require("@marko/compiler");
  compiler.compileSync(source, "/tmp/mx-core-test/custom-tags.mx", {
    translator,
    output: "html",
    writeVersionComment: false,
  });
  if (thrown) throw thrown;
  if (!ir) throw new Error("resolver produced no IR");
  return ir;
}

/** `Attr`'s spread variant carries no `name`, so narrow before reading one. */
function named(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((attr) => attr.kind !== "spread" && attr.name === name);
}

/** A tag returning one `<svg>` with the attributes it was handed. */
const svgTag: CustomTagDefinition = {
  expand(call, ctx) {
    const name = named(call.attrs, "name");
    // `throw ctx.fail(...)`, not a bare call: `fail`'s `never` return narrows
    // only when the call is in a `throw` (or the reference is a const). A
    // real feature would ship this idiom in its docs — see
    // `CustomTagContext.fail`.
    if (!name) throw ctx.fail("requires a `name` attribute");
    if (name.kind !== "static") {
      throw ctx.fail("`name` must be a static string", name.loc);
    }
    return [
      ctx.build.element(
        "svg",
        [ctx.build.attr("data-name", name.value)],
        [ctx.build.element("path", [ctx.build.attr("d", "M0 0")])],
      ),
    ];
  },
};

function find<K extends IrNode["kind"]>(
  nodes: IrNode[],
  kind: K,
): Extract<IrNode, { kind: K }> {
  for (const node of nodes) {
    if (node.kind === kind) return node as Extract<IrNode, { kind: K }>;
    const children =
      "children" in node && Array.isArray(node.children)
        ? (node.children as IrNode[])
        : [];
    for (const branch of node.kind === "IfChain" ? node.branches : []) {
      const hit = tryFind(branch.children, kind);
      if (hit) return hit;
    }
    const hit = tryFind(children, kind);
    if (hit) return hit;
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

describe("custom tags", () => {
  it("expands to ordinary IR that no host has to know about", () => {
    const ir = resolveWithTags(
      `import icon from "./icon.tag.ts"\n<icon name="check"/>\n`,
      { icon: svgTag },
    );
    const svg = find(ir.body, "Element");
    expect(svg.name).toBe("svg");
    expect(svg.attrs).toEqual([
      expect.objectContaining({
        kind: "static",
        name: "data-name",
        value: "check",
      }),
    ]);
    expect(svg.children[0]).toMatchObject({ kind: "Element", name: "path" });
    // No `HostTag` and no `Component`: the tag is gone by the time a host
    // sees the tree, which is decision 80's central claim.
    expect(tryFind(ir.body, "HostTag")).toBeNull();
    expect(tryFind(ir.body, "Component")).toBeNull();
  });

  it("stamps the call site on synthetic nodes", () => {
    const ir = resolveWithTags(
      `import icon from "./icon.tag.ts"\n<div>\n  <icon name="check"/>\n</div>\n`,
      { icon: svgTag },
    );
    const svg = find(ir.body, "Element").children[0] as Extract<
      IrNode,
      { kind: "Element" }
    >;
    expect(svg.name).toBe("svg");
    // The `<icon>` call is on line 3; nothing synthetic may claim any other.
    expect(svg.loc.line).toBe(3);
    expect(svg.children[0]?.loc.line).toBe(3);
  });

  it("keeps author-written material's real positions", () => {
    // The tag relocates the body it was handed, unchanged.
    const passthrough: CustomTagDefinition = {
      expand: (call) => call.content?.children ?? [],
    };
    const ir = resolveWithTags(
      `import box from "./box.tag.ts"\n<box>\n  <p>hello</p>\n</box>\n`,
      { box: passthrough },
    );
    const p = find(ir.body, "Element");
    expect(p.name).toBe("p");
    expect(p.loc.line).toBe(3);
  });

  it("gives the tag its attrs, body, attribute tags and params", () => {
    let seen: CustomTagCall | null = null;
    const capture: CustomTagDefinition = {
      expand(call, ctx) {
        seen = call;
        return [ctx.build.text("")];
      },
    };
    resolveWithTags(
      [
        `import t from "./t.tag.ts"`,
        `<t|row| rows=input.files count=3>`,
        `  <@column heading="Name">a</@column>`,
        `  <@column heading="Size">b</@column>`,
        `  body text`,
        `</t>`,
        ``,
      ].join("\n"),
      { t: capture },
    );
    const call = seen as unknown as CustomTagCall;
    expect(call.name).toBe("t");
    expect(call.params).toEqual(["row"]);
    expect(
      call.attrs.map((a) => (a.kind === "spread" ? "<spread>" : a.name)),
    ).toEqual(["rows", "count"]);
    expect(call.attrs[0]).toMatchObject({ kind: "dynamic" });
    // Repeated attribute-tag names stay repeated entries, as Marko does it.
    expect(call.attributeTags.map((t) => t.name)).toEqual(["column", "column"]);
    expect(call.content?.children.length).toBeGreaterThan(0);
  });

  it("routes `ctx.fail` to the position the tag chose", () => {
    expect(() =>
      resolveWithTags(
        `import icon from "./icon.tag.ts"\n<icon name=dynamic()/>\n`,
        { icon: svgTag },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: "`<icon>`: `name` must be a static string",
        line: 2,
      }),
    );
  });

  it("wraps an unexpected throw at the call site, naming the tag", () => {
    const broken: CustomTagDefinition = {
      expand() {
        throw new Error("boom");
      },
    };
    let error: unknown;
    try {
      resolveWithTags(`import b from "./b.tag.ts"\n<b/>\n`, { b: broken });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as TranslateError).message).toBe(
      "`<b>`: custom tag threw: boom",
    );
    expect((error as TranslateError).line).toBe(2);
  });

  it("enforces the depth cap", () => {
    // A tag calling its own `expand` recursively, the one shape the contract
    // cannot prevent structurally (IR holds no unresolved tag names, so a tag
    // cannot emit a call to another by name).
    const recursive: CustomTagDefinition = {
      expand(call, ctx) {
        return recursive.expand(call, ctx);
      },
    };
    expect(() =>
      resolveWithTags(`import r from "./r.tag.ts"\n<r/>\n`, { r: recursive }),
    ).toThrowError(/custom tag threw: Maximum call stack|exceeded/);
  });

  it("enforces the node cap", () => {
    const huge: CustomTagDefinition = {
      expand: (_call, ctx) =>
        Array.from({ length: MAX_EXPANSION_NODES + 1 }, () =>
          ctx.build.text("x"),
        ),
    };
    expect(() =>
      resolveWithTags(`import h from "./h.tag.ts"\n<h/>\n`, { h: huge }),
    ).toThrowError(new RegExp(`over the ${MAX_EXPANSION_NODES} limit`));
  });

  it("declares a depth limit at all", () => {
    expect(MAX_EXPANSION_DEPTH).toBeGreaterThan(0);
  });

  it("nests author-written tags inside-out, for free", () => {
    // `resolve` walks children before the parent, so the outer tag's
    // `content` already holds the inner tag's expansion — there is no
    // expansion-order question to answer.
    const wrap: CustomTagDefinition = {
      expand: (call, ctx) => [
        ctx.build.element("section", [], call.content?.children ?? []),
      ],
    };
    const ir = resolveWithTags(
      [
        `import outer from "./outer.tag.ts"`,
        `import icon from "./icon.tag.ts"`,
        `<outer>`,
        `  <icon name="check"/>`,
        `</outer>`,
        ``,
      ].join("\n"),
      { outer: wrap, icon: svgTag },
    );
    const section = find(ir.body, "Element");
    expect(section.name).toBe("section");
    expect(section.children[0]).toMatchObject({ kind: "Element", name: "svg" });
  });

  it("splices a multi-root expansion in place", () => {
    const two: CustomTagDefinition = {
      expand: (_call, ctx) => [ctx.build.element("i"), ctx.build.element("b")],
    };
    const ir = resolveWithTags(`import t from "./t.tag.ts"\n<t/>\n`, {
      t: two,
    });
    expect(
      ir.body.filter((n) => n.kind === "Element").map((n) => n.name),
    ).toEqual(["i", "b"]);
  });

  it("builds a HostTag by asking the host, never by forging `data`", () => {
    // The escape hatch (investigation §6 case 2): the tag says *what*, the
    // host says *how*. The core calls the host's own `resolveHostTag`, so the
    // tag never sees a `data` shape and the host's real validation runs.
    const boundary: CustomTagDefinition = {
      expand: (call, ctx) => [
        ctx.build.hostTag(
          "try",
          call.content?.children ?? [],
          call.attributeTags,
        ),
      ],
    };
    const policy = fakeDeclarations({
      claimsTag: (name) => name === "try",
      resolveHostTag: (name) => ({ kind: name }),
    });
    const ir = resolveWithTags(
      `import b from "./b.tag.ts"\n<b><p>x</p></b>\n`,
      { b: boundary },
      policy,
    );
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.name).toBe("try");
    expect(hostTag.tag.data).toEqual({ kind: "try" });
    expect(hostTag.tag.children[0]).toMatchObject({
      kind: "Element",
      name: "p",
    });
  });

  it("refuses a HostTag name the host does not claim", () => {
    const boundary: CustomTagDefinition = {
      expand: (_call, ctx) => [ctx.build.hostTag("suspense", [], [])],
    };
    expect(() =>
      resolveWithTags(`import b from "./b.tag.ts"\n<b/>\n`, { b: boundary }),
    ).toThrowError(
      "`<b>`: this host does not claim `<suspense>`, so a custom tag cannot emit one",
    );
  });

  it("changes nothing when no custom tag is registered", () => {
    // The regression guard the acceptance criteria name: with an empty map
    // the resolver takes exactly its old branches, so `<icon>` is an unbound
    // component call and fails as it always did.
    expect(() =>
      resolveWithTags(`<Icon/>\n`, {}, fakeDeclarations()),
    ).toThrowError(/has no matching import/);
  });
});
