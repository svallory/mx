import { describe, expect, it } from "vitest";
import { type Node, parseFragment } from "./index.ts";

/**
 * The fragment front door: positions reported against the *enclosing* file.
 *
 * Everything asserted here is measured behaviour of `@marko/compiler` 5.42.5
 * plus the shift, matching `notes/research/marko-seam-spikes.md` spike 1: only
 * `loc.{line,column}` exists on Marko's own nodes, and `loc.*.index` (not
 * `start`/`end`) carries the offset on the Babel expression nodes nested
 * inside them.
 */

/** The first tag in a fragment's body. */
function firstTag(body: Node[]): Node {
  const tag = body.find((node: Node) => node.type === "MarkoTag");
  if (!tag) throw new Error("no MarkoTag in fragment body");
  return tag;
}

describe("parseFragment shifts positions by the base", () => {
  it("shifts a tag on the fragment's first line by line and column", () => {
    // A fragment starting at file line 6, column 8 (spike 1's own numbers).
    const { body } = parseFragment('<div class="a">x</div>\n', {
      filename: "Counter.solid.mx",
      baseOffset: 120,
      baseLine: 5,
      baseColumn: 8,
    });
    expect(firstTag(body).loc.start).toMatchObject({ line: 6, column: 8 });
  });

  it("shifts a later line's line only, leaving its column alone", () => {
    // Line 2 of the fragment begins at column 0 in the file too, so only the
    // line moves — the base column applies to the first line and nowhere else.
    const { body } = parseFragment("<div>\n  <span>x</span>\n</div>\n", {
      baseLine: 10,
      baseColumn: 4,
      baseOffset: 200,
    });
    const outer = firstTag(body);
    const inner = firstTag(outer.body.body);
    expect(outer.loc.start).toMatchObject({ line: 11, column: 4 });
    expect(inner.loc.start).toMatchObject({ line: 12, column: 2 });
  });

  it("shifts an attribute and the offset index on its value expression", () => {
    const { body } = parseFragment(
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
    // Raw `{ line: 2, column: 5 }`: line shifts, column does not (line 2).
    expect(attr.loc.start).toMatchObject({ line: 4, column: 5 });
    // The nested Babel expression is where a numeric offset exists at all, and
    // it lives inside `loc` rather than on the node (spike 1's second finding).
    // Raw index of `input.url` is 16; the file's is 16 + 42. Getting 100 here
    // means a node was shifted twice — the reason `shiftNode` keeps a seen set.
    expect(attr.value.loc.start.index).toBe(58);
  });

  it("shifts loc.end as well as loc.start", () => {
    // Both ends of a node's range move, and a node that spans lines has its
    // end on a later line where the base column must *not* apply.
    const { body } = parseFragment("<div>\n  <span>x</span>\n</div>\n", {
      baseLine: 4,
      baseColumn: 3,
      baseOffset: 50,
    });
    const outer = firstTag(body);
    // Raw: start { line: 1, column: 0 }, end { line: 3, column: 6 }.
    expect(outer.loc.start).toMatchObject({ line: 5, column: 3 });
    expect(outer.loc.end).toMatchObject({ line: 7, column: 6 });
    const inner = firstTag(outer.body.body);
    // Raw: start { line: 2, column: 2 }, end { line: 2, column: 16 } — one
    // line, neither end on the fragment's first line, so both columns stand.
    expect(inner.loc.start).toMatchObject({ line: 6, column: 2 });
    expect(inner.loc.end).toMatchObject({ line: 6, column: 16 });
  });

  it("shifts a text node's own position", () => {
    const { body } = parseFragment("<p>hello</p>\n", {
      baseLine: 3,
      baseColumn: 2,
    });
    const text = firstTag(body).body.body.find(
      (node: Node) => node.type === "MarkoText",
    );
    expect(text.value).toBe("hello");
    // Raw `{ line: 1, column: 3 }`, on the fragment's first line, so the base
    // column applies: 3 + 2.
    expect(text.loc.start).toMatchObject({ line: 4, column: 5 });
  });

  it("reports file-relative positions with a zero base unchanged", () => {
    const { body } = parseFragment("<p>x</p>\n");
    expect(firstTag(body).loc.start).toMatchObject({ line: 1, column: 0 });
  });
});

describe("parseFragment shifts a thrown parse error", () => {
  /**
   * A parse error's position is on the exception object, never in a tree, so
   * the tree walk can never reach it (spike 1, limit 2). It is shifted
   * separately and the same error rethrown.
   */
  it("shifts err.loc for an error on the fragment's first line", () => {
    type Positioned = { loc?: { start?: { line: number; column: number } } };
    let caught: Positioned | null = null;
    try {
      parseFragment("<div>unclosed\n", {
        baseLine: 7,
        baseColumn: 4,
        baseOffset: 90,
      });
    } catch (error) {
      caught = error as Positioned;
    }
    expect(caught).not.toBeNull();
    // Raw `{ line: 1, column: 0 }` for an unclosed `<div>`; on the fragment's
    // first line, so both halves of the base apply.
    expect(caught?.loc?.start).toMatchObject({ line: 8, column: 4 });
  });
});
