import { describe, expect, it } from "vitest";
import type { Policy } from "./index.ts";
import { compileSource } from "./index.ts";

/**
 * `emitStatement`'s widened `export` hoisting (decision 76b), against a fake
 * host policy — this is a core-level, host-agnostic capability change (every
 * host that compiles through `@mxlang/core` gets it, not only
 * `@mxlang/astro`'s page mode that motivated it), so it needs a core test
 * independent of `packages/astro/src/vite-pages.test.ts`'s page fixtures.
 *
 * Before this change, any top-level `export` other than `export interface
 * Input` was a hard compile error. Now any top-level `export` statement
 * hoists verbatim to real module scope, the same way `import` already does.
 * Verified against real Marko too
 * (`packages/translator/fixtures-marko/export-statements`, checked by
 * `oracle:marko`): `export function`/`export let` are within decision 72's
 * "strict Marko subset" rule, not an MX-only extension.
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

function compileWith(source: string): string {
  return compileSource(source, "/tmp/mx-core-test/probe.mx", fakePolicy()).code;
}

describe("emitStatement: top-level export hoisting", () => {
  it("hoists export const verbatim to module scope", () => {
    const code = compileWith('export const greeting = "hi";\n\n<p>x</p>\n');
    expect(code).toContain('export const greeting = "hi";');
  });

  it("hoists export function verbatim to module scope", () => {
    const code = compileWith(
      "export function greet() { return 1; }\n\n<p>x</p>\n",
    );
    expect(code).toContain("export function greet() { return 1; }");
  });

  it("hoists export class verbatim to module scope", () => {
    const code = compileWith("export class Foo {}\n\n<p>x</p>\n");
    expect(code).toContain("export class Foo {}");
  });

  it("hoists export let verbatim to module scope", () => {
    const code = compileWith("export let count = 0;\n\n<p>x</p>\n");
    expect(code).toContain("export let count = 0;");
  });

  it("hoists export var verbatim to module scope", () => {
    const code = compileWith("export var x = 1;\n\n<p>x</p>\n");
    expect(code).toContain("export var x = 1;");
  });

  it("still lifts export interface Input separately, above the render function", () => {
    const code = compileWith(
      "export interface Input { name: string }\n\n<p>${input.name}</p>\n",
    );
    expect(code).toContain("export interface Input { name: string }");
    // Not hoisted into the same verbatim-export bucket as other statements —
    // it is placed by `ctx.inputInterface`, not `ctx.hoisted`.
    const inputIdx = code.indexOf("export interface Input");
    const defaultIdx = code.indexOf("export default");
    expect(inputIdx).toBeGreaterThan(-1);
    expect(inputIdx).toBeLessThan(defaultIdx);
  });

  it("still rejects a non-export, non-import, non-static statement tag", () => {
    // `emitStatement` only recognizes import/static/export forms; anything
    // else reaching it is a core bug surface, not an author-facing construct
    // — there is no MX syntax that produces one today, so this pins the
    // fail() branch stays intact rather than exercising it end to end.
    expect(() => compileWith('import x from "y";\n\n<p>x</p>\n')).not.toThrow();
  });
});
