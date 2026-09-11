---
title: "Core and hosts"
description: "How @mxlang/core and each host divide responsibility."
---

# Core and hosts

`@mxlang/core` is the half of MX that is the same for every host. It depends on `@marko/compiler` and nothing else: it consumes Marko's AST, applies the structural lowerings — `<if>`, every `<for>` form, `<define>`, `<const>`, statement tags, and a set of guards that reject unsupported node shapes — and asks a `Policy` object for everything host-specific.

## What belongs where

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, and why |
| Guards against unsupported fields and node shapes | Component-versus-element resolution, and what a component call emits |
| The default string-emit model (below) | Structured attribute values (`class`, `style`), attribute order, modifiers |
| The two front doors (`compileSource`, `parseFragment`) | Stateful tags (`<let>`, `<effect>`, `:=`), through three hooks |
| The `escape` helper | Its own integration — a Vite plugin, a Bun loader, a TypeScript plugin |

A host is small because most of the work — parsing, structural lowering, guarding against nonsense — never has to be rewritten. See [Policy and hooks](/architecture/policy-and-hooks/) for the full contract a host implements.

## Two front doors

**`compileSource(source, filename, policy, host?)`** compiles a whole file through `@marko/compiler`'s translator seam. This is what a host uses when the entire file is MX — the HTML host's `.mx` files, for example.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn })`** parses a Marko *substring* embedded inside a larger file, with every position shifted so error locations and source maps point at the right place in the outer file. This is what a host uses when MX syntax sits inside something else — Astro's `.amx` templates (MX after a frontmatter fence) and SolidMX's `.solid.mx` files (MX in JSX's position inside a TSX file) both use this door.

## The emit model

By default, the core emits plain strings: an `out += "..."` buffer, one block per function, a fixed set of void HTML tags, and a conventional module shape (an `escape` import, the author's hoisted `import`/`export` statements, one default-exported render function). Any host that itself renders to a string — the HTML host today, the Astro host for its component/page compilation — reuses this emit model as-is, which is most of why adding a second string-shaped host is inexpensive.

A host whose target is expression-shaped rather than statement-shaped — JSX, for SolidMX and for `.amx` templates — cannot configure its way into the default emit model, because JSX has no equivalent of `out += "..."`. Those hosts replace the emit layer entirely rather than trying to bend it: the structural walk (deciding what an `<if>` or a `<for>` means) is shared, but what gets *produced* for each node is different.
