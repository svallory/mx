# @mxlang/parser

MX's parser is a fork of `@babel/parser` with one plugin function replaced:
the JSX element parser, so `<` in expression position opens an MX region
instead of a JSX element. `@babel/parser` has no public plugin API, so a fork
means owning and building its source ourselves; see
`notes/research/parser-fork-strategy.md` at the space root for why the
alternatives (patching the published bundle, acorn, oxc/swc) were rejected.

## What this package does

This package's job is **region discovery only**: finding where an MX region
starts and ends inside a `.solid.mx` file's surrounding TypeScript, and
handing the region's raw text off to be lowered elsewhere. It does no MX
lowering itself.

- `walk.ts` — walks one MX region with `htmljs-parser` (`walkMxRegion`) and
  returns its raw tree (`MxElement`, `MxAttr`, `MxChild`, …) plus the byte
  range the region occupies in the file. This layer does no lowering and no
  TypeScript parsing: it only records what htmljs-parser found and where.
- `bridge.ts` — the parser-facing surface (`mxParseElementAt`), called from
  the vendored JSX plugin in place of `jsxParseElementAt` wherever `<`
  appears in expression position. It calls `walkMxRegion` to find the
  region's end, slices the region's raw source text, and passes it to
  `@mxlang/solid`'s `compileSolidMx` (which does the actual MX-to-Solid-JSX
  lowering, over `@mxlang/core`'s IR) along with the region's file-relative
  base position (`baseOffset`/`baseLine`/`baseColumn`). The resulting JSX
  text is re-parsed with Babel's own expression parser and spliced back into
  the surrounding TypeScript AST at the tokenizer position the MX region
  occupied, so error positions and source maps stay anchored to the original
  `.solid.mx` file. See `packages/hosts/solid/README.md` for the lowering
  table itself and everything downstream of the region hand-off.

  **Note on fragments:** TSX fragments (`<>...</>`) are supported in `.solid.mx` files, but their text children are parsed by Babel as standard TSX text, not MX text. MX parsing rules (like Marko's whitespace collapsing) only apply inside an explicit MX element. Because `${x}` would silently parse as literal text `$` followed by a JSX expression `{x}` in TSX, the parser detects and throws an error for `${` in fragment text. Use standard `{x}` for expressions outside of an MX element.

`@mxlang/parser` depends on `@mxlang/solid` for that hand-off; tooling
packages (`vite-plugin`, `tsc`, `babel-plugin`, `eslint-plugin`,
`typescript-plugin`) keep importing `@mxlang/parser` unchanged — the
`compileSolidMx` call is internal to the bridge, not part of this package's
public surface (`src/public.d.ts`).

`lower.ts`, `control.ts` and `attrs.ts` — the modules that used to lower the
raw `walk.ts` tree to Solid JSX text directly inside this package — are
deleted; that lowering now happens in `@mxlang/solid` over the shared core
IR, the same as the HTML and Astro hosts. Their test files
(`control.test.ts`, `attrs.test.ts`, `render-props.test.ts`) stay, now
exercising the same behavior end to end through `mxParseElementAt`.

The vendored Babel tree is still on the parse path: it is what recognizes
`<` in expression position and calls into `walk.ts`/`bridge.ts` in the first
place. Whether that recognition could instead happen without a vendored
Babel fork (region discovery driven some other way) was not attempted in
this task.

## Build

```
bun run build   # from packages/parser, or `bun run build` at the repo root
```

Produces `dist/index.js` (ESM) from `src/index.ts`, re-exporting `parse`,
`parseExpression`, and the option/result types from the vendored entry.
Babel's compile-time flags (`process.env.BABEL_8_BREAKING`,
`process.env.USE_ESM`, `process.env.IS_PUBLISH`) are resolved via `bun
build --define` so no `process.env` lookups survive in `dist/`.

## Re-vendor

```
packages/parser/scripts/vendor.sh [tag]   # defaults to the pinned tag
```

Idempotent: deletes `src/babel/` and re-fetches. Does not reapply the local
modifications, rebuild, or rerun tests — see `UPSTREAM.md`'s "Re-vendoring
procedure" for what to do after running it.

## Pinned versions

See the root `README.md` "Pinned versions" table for `@babel/parser`,
`@babel/types`, and friends. This package additionally pins two vendoring-
only devDependencies not otherwise used at runtime by any other package:

| Package | Version | Why |
|---|---|---|
| `charcodes` | 0.2.0 | `@babel/parser`'s own runtime dependency for character-code constants; not published with types under npm's normal resolution for the way `@babel/parser` ships, so pinned directly. |
| `@babel/helper-validator-identifier` | 7.28.5 | `@babel/parser`'s own runtime dependency for identifier validation. |
| `@types/charcodes` | 0.2.2 | `charcodes` ships no types of its own. |
| `@types/babel__helper-validator-identifier` | 7.15.2 | `@babel/helper-validator-identifier` ships no types of its own (a gap in Babel's own npm publish). |

`@babel/helper-string-parser` (7.27.1) is **not** a devDependency here — it's
vendored as source into `src/babel/util/string-parser.ts` instead of
installed as a package, since it ships no `.d.ts` and is meant to be
inlined (see `UPSTREAM.md`). Its version is pinned in `UPSTREAM.md`, not in
this table, since there's no `package.json` entry to pin.
