# @mx/parser

MX's parser is a fork of `@babel/parser` with one plugin function replaced
(the JSX element parser — not done yet, see below). `@babel/parser` has no
public plugin API, so a fork means owning and building its source ourselves;
see `notes/research/parser-fork-strategy.md` at the space root for why the
alternatives (patching the published bundle, acorn, oxc/swc) were rejected.

This package currently only vendors and builds `@babel/parser` unmodified
(the build spike) — see `UPSTREAM.md` for the exact pin, what was dropped,
and every local modification. No MX syntax and no JSX plugin edits yet.

## Build

```
bun run build   # from packages/mx-parser, or `bun run build` at the repo root
```

Produces `dist/index.js` (ESM) from `src/index.ts`, re-exporting `parse`,
`parseExpression`, and the option/result types from the vendored entry.
Babel's compile-time flags (`process.env.BABEL_8_BREAKING`,
`process.env.USE_ESM`, `process.env.IS_PUBLISH`) are resolved via `bun
build --define` so no `process.env` lookups survive in `dist/`.

## Re-vendor

```
packages/mx-parser/scripts/vendor.sh [tag]   # defaults to the pinned tag
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
| `@babel/helper-string-parser` | 7.27.1 | Vendored as source instead of consumed as a package — see `UPSTREAM.md` — pinned here only to track the exact version vendored. |
| `@types/charcodes` | 0.2.2 | `charcodes` ships no types of its own. |
| `@types/babel__helper-validator-identifier` | 7.15.2 | `@babel/helper-validator-identifier` ships no types of its own (a gap in Babel's own npm publish). |
