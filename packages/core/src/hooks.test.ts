import { describe, expect, it } from "vitest";
import type { Policy } from "./index.ts";
import {
  type Ctx,
  compileSource,
  emitChildren,
  type Node,
  newCtx,
} from "./index.ts";

/**
 * The three stateful-tag hooks of decision 70, each against a *fake* host
 * policy.
 *
 * MX does not define `<let>`, `<effect>` or `:=`; a host does, and the core
 * only has to give it the three capabilities it needs: a tag handler
 * (`emitSpecial`), a way to lift a declaration to the enclosing function
 * (`ctx.hoist`), and a way to rewrite references to a binding it owns
 * (`ctx.bindings`). The fake policy here is the smallest host that exercises
 * all three; no real host uses them yet (`@mxlang/translator` renders a
 * `<let>`'s initial value instead), so these tests are the only thing keeping
 * the hooks honest.
 */

/** A minimal policy: every tag is an element, nothing is a component. */
function fakePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: () => false,
    emitComponent: () => {
      throw new Error("unused");
    },
    escapeFrom: "@mxlang/core",
    ...overrides,
  };
}

/**
 * Compiles `source` with a fake host policy, returning the emitted module.
 *
 * Goes through the real front door rather than a hand-built AST: a hook that
 * works only when the test drives the emitter directly is not a hook a host
 * can use.
 */
function compileWith(source: string, policy: Policy): string {
  return compileSource(source, "/tmp/mx-core-test/probe.mx", policy).code;
}

describe("the hoist hook", () => {
  /**
   * A host's stateful declaration has to outlive the block it was written in:
   * `<let/count=0/>` inside an `<if>` is still readable after the branch in
   * a framework whose state lives in the component, not in the JS block. The
   * core cannot know that, so `ctx.hoist` lets the host say it.
   */
  const hoistingPolicy = fakePolicy({
    emitSpecial(ctx: Ctx, node: Node, name: string): boolean {
      if (name !== "signal") return false;
      const value = node.attributes?.[0];
      ctx.hoist(`const ${node.var.name} = ${value ? value.value.value : "0"};`);
      return true;
    },
  });

  it("places a statement hoisted from inside an <if> at the function head", () => {
    const code = compileWith(
      "<if=input.on>\n  <signal/count=7/>\n</if>\n<p>${count}</p>\n",
      hoistingPolicy,
    );
    const lines = code.split("\n");
    const head = lines.findIndex((l) => l.includes('let out = "";'));
    const hoisted = lines.findIndex((l) => l.includes("const count = 7;"));
    const branch = lines.findIndex((l) => l.includes("if (input.on)"));

    expect(hoisted).toBeGreaterThan(head);
    // The whole point: the declaration is *before* the block it was written
    // in, so a reference after the block still resolves.
    expect(hoisted).toBeLessThan(branch);
  });

  it("hoists to the nearest of two nested block functions", () => {
    // Two `<define>` levels: the inner hoist belongs to the inner function, the
    // outer one to the outer function, and neither reaches the render function.
    // A single-level test cannot tell "nearest enclosing" from "innermost seen".
    const code = compileWith(
      [
        "<define/outer|a|>",
        "  <signal/outerSeen=1/>",
        "  <define/inner|b|>",
        "    <signal/innerSeen=2/>",
        "    <p>${a}${b}${innerSeen}</p>",
        "  </define>",
        "  <p>${outerSeen}</p>",
        "</define>",
        "",
      ].join("\n"),
      hoistingPolicy,
    );

    const outerAt = code.indexOf("const outer =");
    const innerAt = code.indexOf("const inner =");
    const outerHoist = code.indexOf("const outerSeen = 1;");
    const innerHoist = code.indexOf("const innerSeen = 2;");

    // Each hoist is inside its own function, and the outer one precedes the
    // inner function's declaration rather than being dragged into it.
    expect(outerHoist).toBeGreaterThan(outerAt);
    expect(outerHoist).toBeLessThan(innerAt);
    expect(innerHoist).toBeGreaterThan(innerAt);
    // Neither escaped to the render function's own head.
    expect(code.slice(0, outerAt)).not.toContain("Seen =");
  });

  it("hoists to the nearest block function, not past it", () => {
    // A `<define>` compiles to its own `() => string`, and a statement hoisted
    // from inside it belongs at *that* function's head: it may read the
    // define's own params, which do not exist in the render function.
    const code = compileWith(
      "<define/row|item|>\n  <signal/seen=1/>\n  <p>${item}${seen}</p>\n</define>\n",
      hoistingPolicy,
    );
    const body = code.slice(code.indexOf("const row ="));
    const hoisted = body.indexOf("const seen = 1;");
    const buffer = body.indexOf('let out = "";');
    expect(hoisted).toBeGreaterThan(-1);
    expect(hoisted).toBeLessThan(buffer);
    // And it did not escape to the render function's own head.
    expect(code.slice(0, code.indexOf("const row ="))).not.toContain(
      "const seen = 1;",
    );
  });
});

describe("the binding registry", () => {
  /**
   * A host whose state is a getter (`count()` in Solid) needs every reference
   * the author wrote as `count` to emit the call. That is a rewrite over
   * *reference positions only* — the point of registering a name rather than
   * string-replacing it.
   */
  const signalPolicy = fakePolicy({
    emitSpecial(ctx: Ctx, node: Node, name: string): boolean {
      if (name !== "signal") return false;
      const value = node.attributes?.[0];
      ctx.hoist(
        `const ${node.var.name} = () => ${value ? value.value.value : "0"};`,
      );
      ctx.bindings.register(node.var.name, (ref) => `${ref}()`);
      return true;
    },
  });

  it("rewrites a registered name inside a larger expression", () => {
    const code = compileWith(
      "<signal/count=1/>\n<p>${count + 1}</p>\n",
      signalPolicy,
    );
    expect(code).toContain("escape(count() + 1)");
  });

  it("leaves a member's property name alone", () => {
    // `obj.count` reads a property that happens to share the name; rewriting
    // it would emit `obj.count()` and call something that is not the signal.
    const code = compileWith(
      "<signal/count=1/>\n<p>${input.obj.count}</p>\n",
      signalPolicy,
    );
    expect(code).toContain("input.obj.count");
    expect(code).not.toContain("input.obj.count()");
  });

  it("rewrites a bare reference, and an attribute value too", () => {
    const code = compileWith(
      "<signal/count=1/>\n<p title=count>${count}</p>\n",
      signalPolicy,
    );
    expect(code).toContain("escape(count())");
    // Twice: once for the attribute, once for the placeholder.
    expect(code.match(/count\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves a name shadowed inside the expression alone", () => {
    // The arrow's own parameter is not the host's binding, so calling it would
    // be wrong JS. The rewrite only fires for a *free* name, which is the one
    // that refers to the template-level binding.
    const code = compileWith(
      "<signal/count=1/>\n<p>${input.xs.map(count => count).join('')}</p>\n",
      signalPolicy,
    );
    expect(code).toContain("count => count)");
    expect(code).not.toContain("count => count()");
  });

  it("still rewrites a free reference beside a shadowed scope", () => {
    // Same expression shape, but `count` is free inside the arrow, so it is the
    // host's binding and must be called.
    const code = compileWith(
      "<signal/count=1/>\n<p>${input.xs.map(x => x + count).join('')}</p>\n",
      signalPolicy,
    );
    expect(code).toContain("x + count()");
  });

  it("leaves a name shadowed by a const in a block alone", () => {
    // Not just parameters: any binding in the expression's own scope chain.
    const code = compileWith(
      "<signal/count=1/>\n<p>${(() => { const count = 2; return count; })()}</p>\n",
      signalPolicy,
    );
    expect(code).not.toContain("return count()");
  });

  /**
   * Declaration positions are never rewritten — the bug the code review on
   * PR #32 found. `expr()` cannot tell a binding site from a reference (a bare
   * `Identifier` has no parent for Babel's `isReferencedIdentifier()` to
   * judge), so every declaration site calls `declName()` instead. Without that
   * split, `<const/count=count + 1>` emitted `const count() = count() + 1` —
   * invalid JS with no diagnostic.
   */
  it("never rewrites a <const>'s own declared name", () => {
    const code = compileWith(
      "<signal/count=1/>\n<const/count=count + 1/>\n<p>${count}</p>\n",
      signalPolicy,
    );
    // The initializer runs before the binding exists, so the right-hand side is
    // still the host's; the left-hand side is a declaration and stays plain.
    expect(code).toContain("const count = count() + 1;");
    expect(code).not.toContain("const count() =");
  });

  it("lets a <const> shadow the host binding for the rest of the scope", () => {
    // After `<const/count=…>` the name is an ordinary JS `const`, so a later
    // `${count}` is that local, not the host's getter — the same rule as a
    // parameter shadowing inside an expression.
    const code = compileWith(
      "<signal/count=1/>\n<const/count=count + 1/>\n<p>${count}</p>\n",
      signalPolicy,
    );
    const after = code.slice(code.indexOf("const count = count() + 1;"));
    expect(after).toContain("escape(count)");
    expect(after).not.toContain("escape(count())");
  });

  it("never rewrites <for> tag params", () => {
    const code = compileWith(
      "<signal/count=1/>\n<for|count| of=input.xs><p>${count}</p></for>\n",
      signalPolicy,
    );
    expect(code).toContain("for (const count of");
    expect(code).not.toContain("const count() of");
    // Inside the loop the param is what `count` means.
    expect(code).toContain("escape(count)");
    expect(code).not.toContain("escape(count())");
  });

  it("never rewrites a <define>'s name or params, and restores after", () => {
    const code = compileWith(
      [
        "<signal/count=1/>",
        "<define/Row|count|>",
        "  <p>${count}</p>",
        "</define>",
        "<p>${count}</p>",
        "",
      ].join("\n"),
      signalPolicy,
    );
    expect(code).toContain("const Row = (count) =>");
    expect(code).not.toContain("count()) =>");
    const body = code.slice(code.indexOf("const Row ="));
    const defineEnd = body.indexOf("};");
    // Inside the define the param wins; outside it, the host's binding is back.
    expect(body.slice(0, defineEnd)).toContain("escape(count)");
    expect(body.slice(defineEnd)).toContain("escape(count())");
  });

  it("leaves everything alone when nothing is registered", () => {
    const code = compileWith("<p>${count + 1}</p>\n", fakePolicy());
    expect(code).toContain("escape(count + 1)");
  });
});

describe("the tag handler hook", () => {
  /**
   * `emitSpecial` is the hook itself: the core dispatches every tag it has no
   * lowering of its own for to the policy, by name, before deciding whether
   * the name is a component or an element. A host implements its stateful tags
   * there — which is how both tests above got a `<signal>` tag the core knows
   * nothing about.
   */
  it("gives the policy every tag the core does not own", () => {
    const seen: string[] = [];
    const code = compileWith(
      "<effect/>\n<p>text</p>\n",
      fakePolicy({
        emitSpecial(ctx: Ctx, _node: Node, name: string): boolean {
          seen.push(name);
          if (name !== "effect") return false;
          // A host that wants the tag gone emits nothing and claims it.
          void ctx;
          return true;
        },
      }),
    );
    expect(seen).toContain("effect");
    expect(code).toContain('out += "<p>text</p>"');
    expect(code).not.toContain("effect");
  });

  it("lets a host emit into the buffer from the hook", () => {
    const code = compileWith(
      "<shout=input.msg/>\n",
      fakePolicy({
        emitSpecial(ctx: Ctx, node: Node, name: string): boolean {
          if (name !== "shout") return false;
          const value = node.attributes?.[0];
          emitChildren(ctx, []);
          ctx.body.push(
            `  out += escape(String(${value.value.object.name}.${value.value.property.name}).toUpperCase());`,
          );
          return true;
        },
      }),
    );
    expect(code).toContain("toUpperCase()");
  });
});

describe("newCtx", () => {
  it("hands a host a context with all three hooks wired", () => {
    const ctx = newCtx("", (node: Node) => String(node), fakePolicy());
    expect(ctx.bindings.size).toBe(0);
    ctx.bindings.register("a", (ref) => `${ref}()`);
    expect(ctx.bindings.size).toBe(1);
    expect(ctx.bindings.get("a")?.("a")).toBe("a()");
    ctx.bindings.unregister("a");
    expect(ctx.bindings.get("a")).toBeUndefined();
    ctx.hoist("const x = 1;");
    expect(ctx.prelude).toEqual(["const x = 1;"]);
  });
});
