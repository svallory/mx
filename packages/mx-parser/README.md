# @markox/parser

MX's parser is a fork of `@babel/parser` with one plugin function replaced
(the JSX element parser — not done yet, see below). `@babel/parser` has no
public plugin API, so a fork means owning and building its source ourselves;
see `notes/research/parser-fork-strategy.md` at the space root for why the
alternatives (patching the published bundle, acorn, oxc/swc) were rejected.

This package currently only vendors and builds `@babel/parser` unmodified
(the build spike) — see `UPSTREAM.md` for the exact pin, what was dropped,
and every local modification. No MX syntax and no JSX plugin edits yet.

## Rules

Two rules are generic over every tag, and are what lets MX call Solid's own
render-prop components natively (decision 51):

**Tag params make the children a function.** `<Tag|p1, p2| attrs>body</Tag>`
lowers to `<Tag attrs>{(p1, p2) => body}</Tag>`, for any tag — components and
HTML elements alike. Solid has no meaning for a function child on a DOM
element; MX lowers it anyway rather than inventing a rule the target does not
have, so `<For|item, i| each=xs()>`, `<Show|u| when=user()>` and
`<Repeat|i| count=n>` all work. Params are parsed exactly as `<for>`'s are,
destructuring and TypeScript annotations included; `||` lowers to `() =>
body`. The body follows the ordinary children rules: a single child stays
bare, several wrap in a fragment, and whitespace is the line-based Marko rule.

**Attribute tags become props.** Inside any tag, `<@name>body</@name>` becomes
`name={body}` on the parent; with params, `<@name|p|>body</@name>` becomes
`name={(p) => body}`. Ordinary children remain `children`, and the emitted
prop order is the parent's own attributes in source order, then the attribute
tags in source order. `<try>` is expressed on top of this rule rather than
beside it — it reads `<@catch>`/`<@placeholder>` out of the same collector
every other tag uses, so the two paths cannot drift.

Parse errors in this area, with their messages:

| Written | Error |
|---|---|
| `<@name attr=…>` | ``attribute tags take params or a body, not attributes (v1)`` |
| the same `<@name>` twice on one parent | ``attribute tag `@name` given twice (repeatable attribute tags are not supported)`` |
| `<@name>` at the top level | ``attribute tag `<@name>` outside a tag body`` |
| `<@name>` inside `<if>`/`<else>`/`<for>`/`<fragment>` | ``attribute tag `<@name>` inside `<if>` `` (etc.) |
| an attribute tag other than `<@catch>`/`<@placeholder>` inside `<try>` | ``attribute tag `<@name>` inside `<try>` `` |

Marko's repeatable attribute tags (which collect into an array prop) are out
of scope for v1, which is why the duplicate case is an error rather than a
merge.

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
| `@types/charcodes` | 0.2.2 | `charcodes` ships no types of its own. |
| `@types/babel__helper-validator-identifier` | 7.15.2 | `@babel/helper-validator-identifier` ships no types of its own (a gap in Babel's own npm publish). |

`@babel/helper-string-parser` (7.27.1) is **not** a devDependency here — it's
vendored as source into `src/babel/util/string-parser.ts` instead of
installed as a package, since it ships no `.d.ts` and is meant to be
inlined (see `UPSTREAM.md`). Its version is pinned in `UPSTREAM.md`, not in
this table, since there's no `package.json` entry to pin.
