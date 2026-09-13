---
title: "Spans and mappings"
description: "How MX maps emitted output back to the original source."
---

# Spans and mappings

When the core lowers structural tags (e.g. `<if>`, `<for>`) to a host's representation (like ternary chains or `.map` calls), the emitted code must still map back to the original source positions in the `.mx` or `.solid.mx` file. This is crucial for TypeScript type checking (the TS plugin) and editor diagnostics.

## Position Mapping

The core parses source using `htmljs-parser` and records source spans for elements, tags, attributes, and expressions. When generating the IR (Intermediate Representation) and subsequently emitting output through a host emitter, these spans are preserved and translated into a sourcemap-like structure.

- **Expressions:** Interpolated expressions (`${foo}`) are sliced from the original source. The core expression printer erases TypeScript type arguments (e.g., `pick<string>("lo")` prints as `pick("lo")`), which means such bare generic calls outside `${}` currently lose their type arguments in the emitted TSX.
- **Component Tags and Attributes:** The exact line/column spans for component tags and their attributes are mapped. If you pass an invalid prop to an imported `.mx` component, the TypeScript error will land precisely on that attribute in your editor.
- **Hoisted Blocks:** `static` blocks and `import` declarations are hoisted to the top of the emitted module. Their spans are meticulously tracked so type errors within a `static` block point to the correct line in the source.

## Known Gaps

There are currently two known gaps in the mapping layer:

1. **Bare generic calls outside `${}`:** As mentioned above, `@marko/compiler`'s `stripTypes` erases type parameters before translation. This means generic arguments placed directly in the template without a surrounding `${}` block misparse or are lost in the source map.
2. **Attribute-method bodies:** Methods defined directly on attributes (e.g., `onClick() { ... }`) have synthetic bodies, and precise column mapping within the method body might drift slightly.
