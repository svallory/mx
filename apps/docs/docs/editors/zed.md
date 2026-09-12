---
title: "Zed"
description: "The mxlang Zed extension: MX, SolidMX, and AstroMX languages, plus diagnostics."
---

# Zed

The `mxlang` extension ships three languages:

- **MX** (`.mx`, and its `.marko` alias) — rides Marko's own tree-sitter grammar and queries unmodified. No overlay: MX 1.0 is a strict subset of Marko syntax, so Marko's own highlighting, brackets, and outline already apply.
- **SolidMX** (`.solid.mx`) — its own grammar, a patched TypeScript/TSX grammar with MX recognized in expression position.
- **AstroMX** (`.amx`) — rides the same Marko grammar as MX, since an `.amx` file's template half *is* MX.

## Install the official Marko extension too

`.mx`/`.amx` files render correctly on their own, but the region of a `.solid.mx` file that contains embedded MX is highlighted through an *injection* — Zed asks for a language named `marko` to highlight that region, and only Zed's official Marko extension provides a language by that name. Install it from Zed's extension registry (Command Palette → "zed: extensions" → search "Marko") before or alongside `mxlang`. Without it, those regions still parse and match brackets correctly — they just render as plain, unhighlighted text.

## `.mx` vs `.solid.mx`

Both languages can match the same file: `Counter.solid.mx` matches `MX`'s `.mx` suffix and `SolidMX`'s `.solid.mx` suffix at once. Zed resolves this by picking the *longest* matching suffix, so `.solid.mx` always wins over `.mx`, regardless of which extension you installed first. `.amx` never contends with either, since `amx` and `mx` are different suffixes.

## What each language gets today

| Language | Highlighting | Language server |
| --- | --- | --- |
| MX (`.mx`) | Yes, from Marko's grammar | Yes — see below |
| AstroMX (`.amx`) | Yes, from Marko's grammar (the frontmatter fence itself highlights as Marko markup, a known limitation) | No |
| SolidMX (`.solid.mx`) | Yes, plus injected highlighting inside embedded MX regions (needs the Marko extension) | Yes — see below |

## Diagnostics language server

The extension registers `@mxlang/language-server` for the `MX` and `SolidMX`
languages. It resolves the server to launch, in order: a local install under
the project (`node_modules/.bin/mxlang-language-server`), a global install,
`bunx @mxlang/language-server --stdio`, then `npx`. Nothing needs to be
configured for a project that already has the package installed one of those
ways.

### Trying it locally

1. Make sure `@mxlang/language-server` is built and reachable — in this monorepo, `bun run build` at the repo root is enough; bun's workspace linking makes `node_modules/.bin/mxlang-language-server` available automatically.
2. Command Palette → "zed: install dev extension" → select the extension's directory.
3. In a test project, add to `package.json`:

   ```json
   { "mxlang": { "host": "html", "strict": true } }
   ```

4. Open an `.mx` file containing a `<let>` tag. Under a `strict` host policy this is rejected — you should see one diagnostic naming the construct.
5. Open a `.solid.mx` file with a `<let>` tag inside an MX region. The Solid
   host rejects the tag and the diagnostic should point to its position in the
   complete TypeScript file. See [Language server](/editors/language-server/)
   for routing and policy details.

## Building the extension from source

Only needed if you're building `mxlang` itself, not for using it once installed. The Rust half that registers the language server compiles to the `wasm32-wasip1` target Zed itself builds extensions to:

```bash
rustup target add wasm32-wasip1
```
