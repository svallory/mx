import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { type Node, parseFragmentNative } from "./index.ts";

/**
 * `parseFragmentNative` proof: same behaviour as `parseFragment`'s shifting
 * shim (`fragment.test.ts`), but produced directly by the two upstream
 * patches (`docs/upstream/htmljs-parser-offset.patch` +
 * `docs/upstream/marko-compiler-offset.patch`) instead of a post-hoc walk.
 *
 * The default/stock-compiler test always runs — `@marko/compiler`'s `Config`
 * type does not know `htmlParseOptions`, but the untyped `compileSync` call
 * inside `parseFragmentNative` accepts and ignores it, which is exactly the
 * "additive, absent-option behaviour unchanged" claim the upstream patch
 * makes for a caller that never sets it (which is every caller today, since
 * nothing consumes this function yet).
 *
 * The position-shift-correctness variants only run once the patched
 * `@marko/compiler`/`htmljs-parser` are linked locally — see "Linking the
 * patched packages" in `docs/upstream/README.md`. They are skipped, not
 * failed, when the installed `@marko/compiler` is stock: detected by probing
 * whether `htmlParseOptions.startLine` actually rebases a position, since a
 * stock compiler silently ignores the option rather than throwing on it.
 */

const require = createRequire(import.meta.url);

function hasNativeOffsetSupport(): boolean {
  try {
    const compiler = require("@marko/compiler");
    const ast = compiler.compileSync("<p>x</p>\n", "probe.mx", {
      output: "source",
      ast: true,
      translator: { taglibs: [], tagDiscoveryDirs: [], translate: {} },
      htmlParseOptions: { startLine: 5, startOffset: 0, startColumn: 0 },
      // biome-ignore lint/suspicious/noExplicitAny: probing untyped compiler config
    } as any).ast;
    const tag = ast.program.body.find((node: Node) => node.type === "MarkoTag");
    return tag?.loc?.start?.line === 6;
  } catch {
    return false;
  }
}

const NATIVE_OFFSET_SUPPORT = hasNativeOffsetSupport();

/** The first tag in a fragment's body. */
function firstTag(body: Node[]): Node {
  const tag = body.find((node: Node) => node.type === "MarkoTag");
  if (!tag) throw new Error("no MarkoTag in fragment body");
  return tag;
}

describe("parseFragmentNative against the stock (unpatched) compiler", () => {
  it("does not throw and returns the expected FragmentResult shape", () => {
    const result = parseFragmentNative("<p>hello</p>\n");
    expect(result.ast).toBeDefined();
    expect(Array.isArray(result.body)).toBe(true);
    expect(firstTag(result.body).type).toBe("MarkoTag");
  });

  it("with a base given but ignored by a stock compiler, still parses", () => {
    // A stock @marko/compiler has no htmlParseOptions support: the option is
    // accepted-and-ignored (untyped call site), so positions come back
    // fragment-relative rather than shifted. This only asserts it doesn't
    // throw — the shifted-position claim is asserted below, gated on
    // NATIVE_OFFSET_SUPPORT.
    expect(() =>
      parseFragmentNative("<p>x</p>\n", {
        baseLine: 5,
        baseColumn: 8,
        baseOffset: 120,
      }),
    ).not.toThrow();
  });
});

describe.skipIf(!NATIVE_OFFSET_SUPPORT)(
  "parseFragmentNative against the patched upstream packages",
  () => {
    // Mirrors fragment.test.ts's shifting-shim assertions exactly, so the two
    // implementations are checked against the same fixtures.
    it("shifts a tag on the fragment's first line by line and column", () => {
      const { body } = parseFragmentNative('<div class="a">x</div>\n', {
        filename: "Counter.solid.mx",
        baseOffset: 120,
        baseLine: 5,
        baseColumn: 8,
      });
      expect(firstTag(body).loc.start).toMatchObject({ line: 6, column: 8 });
    });

    it("shifts a later line's line only, leaving its column alone", () => {
      const { body } = parseFragmentNative(
        "<div>\n  <span>x</span>\n</div>\n",
        {
          baseLine: 10,
          baseColumn: 4,
          baseOffset: 200,
        },
      );
      const outer = firstTag(body);
      const inner = firstTag(outer.body.body);
      expect(outer.loc.start).toMatchObject({ line: 11, column: 4 });
      expect(inner.loc.start).toMatchObject({ line: 12, column: 2 });
    });

    it("shifts an attribute and the offset index on its value expression", () => {
      const { body } = parseFragmentNative(
        "<div>\n  <a href=input.url>x</a>\n</div>\n",
        {
          baseLine: 2,
          baseColumn: 6,
          baseOffset: 42,
        },
      );
      const anchor = firstTag(firstTag(body).body.body);
      const attr = anchor.attributes[0];
      expect(attr.name).toBe("href");
      expect(attr.loc.start).toMatchObject({ line: 4, column: 5 });
      expect(attr.value.loc.start.index).toBe(58);
    });

    it("shifts loc.end as well as loc.start", () => {
      const { body } = parseFragmentNative(
        "<div>\n  <span>x</span>\n</div>\n",
        {
          baseLine: 4,
          baseColumn: 3,
          baseOffset: 50,
        },
      );
      const outer = firstTag(body);
      expect(outer.loc.start).toMatchObject({ line: 5, column: 3 });
      expect(outer.loc.end).toMatchObject({ line: 7, column: 6 });
      const inner = firstTag(outer.body.body);
      expect(inner.loc.start).toMatchObject({ line: 6, column: 2 });
      expect(inner.loc.end).toMatchObject({ line: 6, column: 16 });
    });

    it("reports file-relative positions with a zero base unchanged", () => {
      const { body } = parseFragmentNative("<p>x</p>\n");
      expect(firstTag(body).loc.start).toMatchObject({ line: 1, column: 0 });
    });

    it("shifts err.loc for an error on the fragment's first line", () => {
      type Positioned = { loc?: { start?: { line: number; column: number } } };
      let caught: Positioned | null = null;
      try {
        parseFragmentNative("<div>unclosed\n", {
          baseLine: 7,
          baseColumn: 4,
          baseOffset: 90,
        });
      } catch (error) {
        caught = error as Positioned;
      }
      expect(caught).not.toBeNull();
      expect(caught?.loc?.start).toMatchObject({ line: 8, column: 4 });
    });
  },
);
