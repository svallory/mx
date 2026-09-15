import { describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import { MAX_EXPANSION_DEPTH, MAX_EXPANSION_NODES } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";

function fakeDeclarations(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

function lowerWithTags(
  source: string,
  customTags: Readonly<Record<string, CustomTag>>,
  policy = fakeDeclarations(),
): Ir {
  let ir: Ir | null = null;
  compileSource(source, "/tmp/mx-core-test/custom-tags.mx", policy, {
    customTags,
    tagDiscoveryDirs: [],
    emitIr(lowered) {
      ir = lowered;
      return "";
    },
  });
  if (!ir) throw new Error("lowerer produced no IR");
  return ir;
}

function named(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((attr) => attr.kind !== "spread" && attr.name === name);
}

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

const svgTag: CustomTag = {
  attributes: {
    name: { type: "string", required: true, staticOnly: true },
  },
  transform(call, ctx) {
    const name = named(call.attrs, "name");
    if (name?.kind !== "static") {
      throw ctx.fail("requires a static `name` attribute");
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

describe("custom tag transforms", () => {
  it("expands to ordinary IR that no host has to know about", () => {
    const ir = lowerWithTags('<icon name="check"/>\n', { icon: svgTag });
    const svg = find(ir.body, "Element");
    expect(svg).toMatchObject({ name: "svg" });
    expect(svg.attrs).toEqual([
      expect.objectContaining({
        kind: "static",
        name: "data-name",
        value: "check",
      }),
    ]);
    expect(tryFind(ir.body, "HostTag")).toBeNull();
    expect(tryFind(ir.body, "Component")).toBeNull();
  });

  it("stamps synthetic nodes with the call site", () => {
    const ir = lowerWithTags('<div>\n  <icon name="check"/>\n</div>\n', {
      icon: svgTag,
    });
    const svg = find(ir.body, "Element").children[0];
    expect(svg).toMatchObject({ kind: "Element", name: "svg" });
    expect(svg?.loc.line).toBe(2);
    if (svg?.kind !== "Element") throw new Error("expected svg element");
    expect(svg.children[0]?.loc.line).toBe(2);
  });

  it("keeps author-written material's real position", () => {
    const passthrough: CustomTag = {
      transform: (call) => call.content?.children ?? [],
    };
    const ir = lowerWithTags("<box>\n  <p>hello</p>\n</box>\n", {
      box: passthrough,
    });
    expect(find(ir.body, "Element")).toMatchObject({
      name: "p",
      loc: { line: 2 },
    });
  });

  it("gives transform attrs, content, attribute tags, params, and var", () => {
    let seen: TagCall | null = null;
    const capture: CustomTag = {
      attributeTags: { column: { repeated: true } },
      transform(call, ctx) {
        seen = call;
        void call.attributeTags;
        return [ctx.build.text("")];
      },
    };
    lowerWithTags(
      [
        "<table-of/rows|row| rows=input.rows>",
        "  <@column>a</@column>",
        "  <@column>b</@column>",
        "  body",
        "</table-of>",
      ].join("\n"),
      { "table-of": capture },
    );
    const call = seen as TagCall | null;
    expect(call?.name).toBe("table-of");
    expect(call?.params).toEqual(["row"]);
    expect(call?.var).toBe("rows");
    expect(call?.attributeTags.map((tag) => tag.name)).toEqual([
      "column",
      "column",
    ]);
    expect(call?.content?.children.length).toBeGreaterThan(0);
  });

  it("expands nested source calls inside-out", () => {
    const order: string[] = [];
    const wrap = (name: string): CustomTag => ({
      transform(call, ctx) {
        order.push(name);
        return [ctx.build.element(name, [], call.content?.children ?? [])];
      },
    });
    const ir = lowerWithTags("<outer><inner/></outer>\n", {
      outer: wrap("section"),
      inner: wrap("span"),
    });
    expect(order).toEqual(["span", "section"]);
    expect(find(ir.body, "Element")).toMatchObject({ name: "section" });
  });

  it("splices multiple roots in place", () => {
    const two: CustomTag = {
      transform: (_call, ctx) => [
        ctx.build.element("i"),
        ctx.build.element("b"),
      ],
    };
    const ir = lowerWithTags("<two/>\n", { two });
    expect(
      ir.body
        .filter((node) => node.kind === "Element")
        .map((node) => node.name),
    ).toEqual(["i", "b"]);
  });

  it("lets a custom tag override a host claim and request that primitive", () => {
    // `try` itself is a core-owned built-in (`builtin-tags.ts`) and cannot be
    // registered by a caller — see the "core-owned custom tags" describe
    // block below — so this exercises the general mechanism under a name the
    // core does not reserve.
    const boundary: CustomTag = {
      transform: (call, ctx) => [
        ctx.build.hostTag(
          "boundary",
          call.content?.children ?? [],
          call.attributeTags,
        ),
      ],
    };
    const ir = lowerWithTags(
      "<boundary><p>x</p></boundary>\n",
      { boundary },
      {
        ...fakeDeclarations(),
        claimsTag: (name) => name === "boundary",
        resolveHostTag: (name) => ({ name }),
      },
    );
    expect(find(ir.body, "HostTag").tag).toMatchObject({
      name: "boundary",
      data: { name: "boundary" },
    });
  });

  it("refuses a host primitive the active host does not claim", () => {
    const tag: CustomTag = {
      transform: (_call, ctx) => [ctx.build.hostTag("missing", [], [])],
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: this host does not claim `<missing>`, so a custom tag cannot emit one",
    );
  });

  it("mints unique hygienic names across calls", () => {
    const names: string[] = [];
    const tag: CustomTag = {
      transform: (_call, ctx) => {
        names.push(ctx.gensym("value"));
        return [];
      },
    };
    lowerWithTags("<tag/><tag/>\n", { tag });
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\$mx_tag_value\d+$/);
    expect(names[1]).not.toBe(names[0]);
  });

  it("wraps unexpected throws at the call site with the tag first", () => {
    const broken: CustomTag = {
      transform() {
        throw new Error("boom");
      },
    };
    expect(() => lowerWithTags("\n<broken/>\n", { broken })).toThrowError(
      expect.objectContaining({
        name: "TranslateError",
        message: expect.stringContaining("`<broken>`: custom tag threw: boom"),
        line: 2,
        column: 0,
      }),
    );
  });

  it("keeps ctx.fail's selected author position", () => {
    expect(() =>
      lowerWithTags("\n<icon name=input.name/>\n", { icon: svgTag }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<icon>`: attribute `name` must be a static literal",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a non-array return", () => {
    const broken = {
      transform: () => undefined,
    } as unknown as CustomTag;
    expect(() => lowerWithTags("<broken/>\n", { broken })).toThrowError(
      "`<broken>`: custom tag must return an array of IR nodes",
    );
  });

  it("enforces the nested expansion depth cap", () => {
    const wrap: CustomTag = {
      transform: (call) => call.content?.children ?? [],
    };
    const source = `${"<wrap>".repeat(MAX_EXPANSION_DEPTH + 1)}x${"</wrap>".repeat(MAX_EXPANSION_DEPTH + 1)}`;
    expect(() => lowerWithTags(source, { wrap })).toThrowError(
      new RegExp(`exceeded ${MAX_EXPANSION_DEPTH}`),
    );
  });

  it("enforces the expansion node cap", () => {
    const huge: CustomTag = {
      transform: (_call, ctx) =>
        Array.from({ length: MAX_EXPANSION_NODES + 1 }, () =>
          ctx.build.text("x"),
        ),
    };
    expect(() => lowerWithTags("<huge/>\n", { huge })).toThrowError(
      new RegExp(`over the ${MAX_EXPANSION_NODES} limit`),
    );
  });

  it("changes nothing when no custom tag is registered", () => {
    expect(() => lowerWithTags("<Missing/>\n", {})).toThrowError(
      /has no matching import or `<define>`/,
    );
  });

  it("does not treat names inherited through the map prototype as registrations", () => {
    const inherited = Object.create({ ghost: svgTag }) as Record<
      string,
      CustomTag
    >;
    const ir = lowerWithTags("<ghost/>\n", inherited);
    expect(find(ir.body, "Element")).toMatchObject({ name: "ghost" });
  });
});

describe("custom tag declarations", () => {
  const declared: CustomTag = {
    attributes: {
      name: {
        type: "string",
        required: true,
        staticOnly: true,
        enum: ["check", "x"],
      },
      size: { type: "number", staticOnly: true, default: 24 },
    },
    attributeTags: {
      item: { repeated: true, required: true },
      footer: {},
    },
    transform(call) {
      void call.attributeTags;
      return [];
    },
  };

  it("rejects unknown attributes at the attribute", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check" typo="x"><@item/></declared>\n', {
        declared,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<declared>`: unknown attribute `typo`",
        ),
        line: 2,
      }),
    );
  });

  it("does not treat attributes inherited from Object.prototype as declared", () => {
    expect(() =>
      lowerWithTags(
        '\n<declared name="check" toString="x"><@item/></declared>\n',
        { declared },
      ),
    ).toThrowError(/unknown attribute `toString`/);
  });

  it("rejects a missing required attribute at the call", () => {
    expect(() =>
      lowerWithTags("\n<declared><@item/></declared>\n", { declared }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<declared>`: missing required attribute `name`",
        ),
        line: 2,
        column: 0,
      }),
    );
  });

  it("rejects enum violations at the attribute", () => {
    expect(() =>
      lowerWithTags('\n<declared name="nope"><@item/></declared>\n', {
        declared,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          '`<declared>`: attribute `name` must be one of "check", "x", got "nope"',
        ),
        line: 2,
      }),
    );
  });

  it("rejects a boolean that spells an enum member as a string", () => {
    // `<t mode/>` is boolean `true`. Comparing through `String()` would let it
    // satisfy `enum: ["true"]`; with the declared type in hand it is the wrong
    // type, and the type check reports it before the enum branch is reached.
    const moded: CustomTag = {
      attributes: { mode: { type: "string", enum: ["true", "auto"] } },
      transform: () => [],
    };
    expect(() => lowerWithTags("\n<moded mode/>\n", { moded })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<moded>`: attribute `mode` must be string, got boolean",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a number that spells an enum member as a string", () => {
    // Same class as the boolean above: `size=24` is a numeric literal and must
    // not satisfy `enum: ["24"]`, whose members are strings.
    const sized: CustomTag = {
      attributes: { size: { type: "string", enum: ["24", "32"] } },
      transform: () => [],
    };
    expect(() => lowerWithTags("\n<sized size=24/>\n", { sized })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(
          "`<sized>`: attribute `size` must be string, got number",
        ),
        line: 2,
      }),
    );
  });

  it("rejects a non-string enum value when the declaration omits `type`", () => {
    // `enum` is `string[]`, so an undeclared type still means string. This is
    // the path the type check above does not cover, and the one where
    // comparing through `String()` silently accepted `24` and `true`.
    const loose: CustomTag = {
      attributes: { mode: { enum: ["true", "24"] } },
      transform: () => [],
    };
    for (const [source, got] of [
      ["\n<loose mode/>\n", "boolean"],
      ["\n<loose mode=24/>\n", "number"],
    ] as const) {
      expect(() => lowerWithTags(source, { loose })).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(
            `\`<loose>\`: attribute \`mode\` must be a string from "true", "24", got ${got}`,
          ),
          line: 2,
        }),
      );
    }
    expect(() =>
      lowerWithTags('\n<loose mode="24"/>\n', { loose }),
    ).not.toThrow();
  });

  it("supplies a declared default for an omitted attribute", () => {
    // The transform must see the default as an ordinary attribute, carrying a
    // real literal node, so a tag needs no fallback of its own.
    const seen: Array<{ kind: string; code?: string }> = [];
    const defaulted: CustomTag = {
      attributes: {
        size: { type: "number", default: 24 },
        label: { type: "string", default: "none" },
      },
      transform(call) {
        for (const attr of call.attrs) {
          if (attr.kind === "spread") continue;
          seen.push({
            kind: attr.kind,
            code: attr.kind === "dynamic" ? attr.value.code : undefined,
          });
        }
        return [];
      },
    };

    lowerWithTags("<defaulted/>\n", { defaulted });

    expect(seen).toEqual([
      { kind: "dynamic", code: "24" },
      { kind: "static", code: undefined },
    ]);
  });

  it("leaves a supplied attribute alone rather than defaulting it", () => {
    let size: string | undefined;
    const defaulted: CustomTag = {
      attributes: { size: { type: "number", default: 24 } },
      transform(call) {
        const attr = call.attrs.find(
          (candidate) => candidate.kind === "dynamic",
        );
        size = attr?.kind === "dynamic" ? attr.value.code : undefined;
        return [];
      },
    };

    lowerWithTags("<defaulted size=32/>\n", { defaulted });

    expect(size).toBe("32");
  });

  it("accepts a static numeric literal and rejects a runtime expression", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check" size=24><@item/></declared>\n', {
        declared,
      }),
    ).not.toThrow();
    expect(() =>
      lowerWithTags(
        '\n<declared name="check" size=input.size><@item/></declared>\n',
        { declared },
      ),
    ).toThrowError(/attribute `size` must be a static literal/);
  });

  it("rejects unknown, repeated, and missing required attribute tags", () => {
    expect(() =>
      lowerWithTags('\n<declared name="check"><@unknown/></declared>\n', {
        declared,
      }),
    ).toThrowError("`<declared>`: unknown attribute tag `<@unknown>`");
    expect(() =>
      lowerWithTags('\n<declared name="check"><@toString/></declared>\n', {
        declared,
      }),
    ).toThrowError("`<declared>`: unknown attribute tag `<@toString>`");

    const oneFooter: CustomTag = {
      ...declared,
      attributeTags: { footer: {} },
    };
    expect(() =>
      lowerWithTags(
        '\n<declared name="check"><@footer/><@footer/></declared>\n',
        { declared: oneFooter },
      ),
    ).toThrowError(
      "`<declared>`: attribute tag `<@footer>` may not be repeated",
    );

    expect(() =>
      lowerWithTags('\n<declared name="check"/>\n', { declared }),
    ).toThrowError("`<declared>`: missing required attribute tag `<@item>`");
  });

  it("warns when transform silently drops authored attribute tags", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropping: CustomTag = {
      attributeTags: { item: {} },
      transform: () => [],
    };
    lowerWithTags("<dropping><@item/></dropping>\n", { dropping });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("transform did not read its attributeTags"),
    );
    warn.mockRestore();
  });
});

describe("custom tag phase boundaries", () => {
  it.each(["analyze", "finalize"] as const)(
    "rejects %s clearly until P5",
    (hook) => {
      const tag = {
        transform: () => [],
        [hook]: () => [],
      } as unknown as CustomTag;
      expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
        new RegExp(`${hook}.*not implemented until P5`),
      );
    },
  );

  it("types ctx.store but rejects access clearly until P5", () => {
    const tag: CustomTag = {
      transform(_call, ctx) {
        ctx.store.set("x", 1);
        return [];
      },
    };
    expect(() => lowerWithTags("<tag/>\n", { tag })).toThrowError(
      "`<tag>`: ctx.store is not implemented until P5",
    );
  });

  it("rejects a tag with neither a transform nor a template", () => {
    expect(() => lowerWithTags("<tag/>\n", { tag: {} })).toThrowError(
      "`<tag>`: custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
    );
  });
});

describe("custom tag parse options", () => {
  it("injects text mode before the caller is parsed", () => {
    let content: IrNode[] = [];
    const markdown: CustomTag = {
      parseOptions: { text: true },
      transform(call) {
        content = call.content?.children ?? [];
        return content;
      },
    };
    lowerWithTags("<markdown># title\n1 < 2 && 3 > 2</markdown>\n", {
      markdown,
    });
    expect(content).toEqual([
      expect.objectContaining({
        kind: "Text",
        value: "# title 1 < 2 && 3 > 2",
      }),
    ]);
  });

  it("injects preserveWhitespace mode before the caller is parsed", () => {
    let text = "";
    const preserve: CustomTag = {
      parseOptions: { preserveWhitespace: true },
      transform(call) {
        text =
          call.content?.children
            .filter((node) => node.kind === "Text")
            .map((node) => node.value)
            .join("") ?? "";
        return [];
      },
    };
    lowerWithTags("<preserve>\n  x\n</preserve>\n", { preserve });
    expect(text).toContain("\n  x\n");
  });

  it("injects openTagOnly mode before the caller is parsed", () => {
    const leaf: CustomTag = {
      parseOptions: { openTagOnly: true },
      transform: () => [],
    };
    expect(() => lowerWithTags("<leaf>body</leaf>\n", { leaf })).toThrow();
    expect(() => lowerWithTags("<leaf>\n", { leaf })).not.toThrow();
  });
});

it("uses TranslateError for custom-tag diagnostics", () => {
  try {
    lowerWithTags("<icon/>\n", { icon: svgTag });
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
  }
});

describe("core-owned custom tags", () => {
  const tryDeclarations: Policy = {
    ...fakeDeclarations(),
    claimsTag: (name) => name === "try",
    resolveHostTag: (name) => ({ name }),
  };

  it("rejects a registered `try` custom tag as an attempt to shadow a built-in", () => {
    const shadow: CustomTag = { transform: () => [] };
    expect(() =>
      lowerWithTags("<try><p>x</p></try>\n", { try: shadow }, tryDeclarations),
    ).toThrowError(
      "`<try>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name",
    );
  });

  it("lowers a plain `<try>` to the host's `try` primitive with no attribute tags", () => {
    const ir = lowerWithTags("<try><p>x</p></try>\n", {}, tryDeclarations);
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag).toMatchObject({ name: "try" });
    expect(hostTag.tag.attributeTags).toEqual([]);
  });

  it("passes `<@catch>`/`<@placeholder>` through as the host tag's attribute tags", () => {
    const ir = lowerWithTags(
      "<try><p>x</p><@catch|e|><p>${e}</p></@catch><@placeholder>wait</@placeholder></try>\n",
      {},
      tryDeclarations,
    );
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.attributeTags.map((tag) => tag.name).sort()).toEqual([
      "catch",
      "placeholder",
    ]);
  });

  it("rejects tag params on `<try>`", () => {
    expect(() =>
      lowerWithTags("<try|a|><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError(/tag params .*on `<try>`/);
  });

  it("rejects a tag variable on `<try>`", () => {
    expect(() =>
      lowerWithTags("<try/v><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError(/tag variable .*on `<try>`/);
  });

  it("rejects an unknown attribute tag inside `<try>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><p>x</p><@other>y</@other></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/unknown attribute tag `<@other>`/);
  });

  it("rejects a repeated `<@catch>` inside `<try>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><@catch>a</@catch><@catch>b</@catch></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/may not be repeated/);
  });

  it("rejects tag params on `<@placeholder>`", () => {
    expect(() =>
      lowerWithTags(
        "<try><@placeholder|v|>wait</@placeholder></try>\n",
        {},
        tryDeclarations,
      ),
    ).toThrowError(/tag params .*on `<@placeholder>`/);
  });

  // Round 1 item 1: `hasContent` treats whitespace-only body text as no
  // content, the right default for a template-authored tag deciding what an
  // empty call means. `<try>` is a structural pass-through, not a template —
  // its body must reach the host unchanged, the way `lowerHostTag` always
  // lowered `node.body?.body ?? []` unconditionally. `lowerCustomTag`'s
  // `isBuiltin` flag skips the `hasContent` gate for built-ins.
  it("preserves a whitespace-only `<try>` body rather than dropping it", () => {
    const ir = lowerWithTags("<try>  </try>\n", {}, tryDeclarations);
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.children).toEqual([
      expect.objectContaining({ kind: "Text", value: " " }),
    ]);
  });

  it("preserves markup mixed with text in a `<try>` body", () => {
    const ir = lowerWithTags("<try>a <b>c</b></try>\n", {}, tryDeclarations);
    const hostTag = find(ir.body, "HostTag");
    expect(hostTag.tag.children).toMatchObject([
      { kind: "Text", value: "a " },
      { kind: "Element", name: "b" },
    ]);
  });

  // Round 1 item 2: a shadowing registration that also sets `parseOptions`
  // used to change how the parser itself read `<try>` before lowering ever
  // ran, surfacing an unrelated parser error instead of the shadow
  // diagnostic. `createTranslator`/`parseOnlyTranslator` now reject the
  // registration before any parse.
  it("rejects a shadowing `try` registration with `parseOptions` before parsing", () => {
    const shadow: CustomTag = {
      parseOptions: { openTagOnly: true },
      transform: () => [],
    };
    expect(() =>
      lowerWithTags("<try><p>x</p></try>\n", { try: shadow }, tryDeclarations),
    ).toThrowError(
      "`<try>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name",
    );
  });

  // Round 1 item 3: an empty `attributes: {}` declaration used to report
  // "spread attributes cannot be checked against this tag's declared
  // attributes" for `<try ...rest>` — a message describing the checker
  // rather than the author's actual mistake.
  it("reports a spread on `<try>` as accepting no attributes", () => {
    expect(() =>
      lowerWithTags("<try ...rest><p>x</p></try>\n", {}, tryDeclarations),
    ).toThrowError("accepts no attributes");
  });
});
