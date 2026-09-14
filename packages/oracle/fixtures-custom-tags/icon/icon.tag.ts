/**
 * `<icon name="check" size=24/>` — the experiment's custom tag (decision 85).
 *
 * The commonest real custom tag, and the one that cannot be a component: the
 * point is that no runtime lookup and no sprite request happens. It expands to
 * an `<svg>` element tree made only of `Element` and static `Attr`, which is
 * IR every host already emits — so the same tag renders on all six with no
 * host change at all. That is the positive claim under test.
 *
 * The icon data is an ordinary object in this module. A real tag may `import`
 * its data (a build-graph dependency the bundler can invalidate); what it must
 * not do is `readFileSync` inside `expand`, which the bundler cannot see.
 */

import type {
  CustomTagCall,
  CustomTagContext,
  CustomTagDefinition,
  IrNode,
} from "@mxlang/core";
import { CUSTOM_TAG } from "@mxlang/core";

/** Path data per icon name. Plain data, resolved at compile time. */
const PATHS: Record<string, string[]> = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  plus: ["M12 5v14", "M5 12h14"],
};

function expand(call: CustomTagCall, ctx: CustomTagContext): IrNode[] {
  const nameAttr = call.attrs.find((attr) => attr.name === "name");
  if (!nameAttr) ctx.fail("requires a `name` attribute");
  // A tag needing a compile-time value tests the attribute's `kind` and fails
  // otherwise, with the squiggle on the offending attribute rather than the
  // whole call. `kind === "static"` is exactly "the author wrote a literal".
  if (nameAttr.kind !== "static") {
    ctx.fail(
      "`name` must be a literal string; an icon is chosen at compile time",
      nameAttr.loc,
    );
  }

  const paths = PATHS[nameAttr.value];
  if (!paths) {
    ctx.fail(
      `no icon named "${nameAttr.value}" (have: ${Object.keys(PATHS).sort().join(", ")})`,
      nameAttr.loc,
    );
  }

  // `size` is optional and, when present, must also be static: it becomes two
  // literal attributes, not an expression a host would have to evaluate.
  const sizeAttr = call.attrs.find((attr) => attr.name === "size");
  let size = "24";
  if (sizeAttr) {
    if (sizeAttr.kind === "static") {
      size = sizeAttr.value;
    } else if (
      sizeAttr.kind === "dynamic" &&
      /^\d+$/.test(sizeAttr.value.code)
    ) {
      // `size=24` parses as a numeric literal, which reaches the IR as a
      // dynamic attribute whose code is the digits. Still compile-time known.
      size = sizeAttr.value.code;
    } else {
      ctx.fail("`size` must be a literal number", sizeAttr.loc);
    }
  }

  // Every other attribute the author wrote is passed through unchanged, so
  // `<icon class="big">` still lands a `class` on the `<svg>`. These are
  // author-written `Attr`s and keep their own positions.
  const passthrough = call.attrs.filter(
    (attr) => attr.name !== "name" && attr.name !== "size",
  );

  return [
    ctx.build.element(
      "svg",
      [
        ctx.build.attr("xmlns", "http://www.w3.org/2000/svg"),
        ctx.build.attr("width", size),
        ctx.build.attr("height", size),
        ctx.build.attr("viewBox", "0 0 24 24"),
        ctx.build.attr("fill", "none"),
        ctx.build.attr("stroke", "currentColor"),
        ctx.build.attr("stroke-width", "2"),
        ...passthrough,
      ],
      paths.map((d) => ctx.build.element("path", [ctx.build.attr("d", d)])),
    ),
  ];
}

const icon: CustomTagDefinition = { expand };

// The marker a real implementation checks after loading, so a module that is
// not a custom tag fails loudly rather than being treated as a component.
Object.defineProperty(icon, CUSTOM_TAG, { value: true });

export default icon;
