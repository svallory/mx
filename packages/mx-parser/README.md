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
| `<@name>` whose name is already an attribute on the parent | ``attribute tag `@name` collides with attribute `name` `` |
| `<@children>` beside any ordinary child | ``attribute tag `@children` collides with the parent's ordinary children`` |
| `<@name>` at the top level | ``attribute tag `<@name>` outside a tag body`` |
| `<@name>` directly inside another attribute tag's body | ``attribute tag `<@name>` inside attribute tag `<@outer>` `` |
| `<@name>` inside `<if>`/`<else>`/`<for>`/`<fragment>` | ``attribute tag `<@name>` inside `<if>` `` (etc.) |
| an attribute tag other than `<@catch>`/`<@placeholder>` inside `<try>` | ``attribute tag `<@name>` inside `<try>` `` |

A **spread is not a collision**: `<Layout ...props><@id>x</@id></Layout>`
lowers without complaint. The collision check reads the parent's attributes by
name, and a spread's keys are not known until runtime, so rejecting on one
would make a legal pattern unusable. This matches JSX, where
`<Layout {...props} id="x" />` is legal and the last writer wins.

Marko's repeatable attribute tags (which collect into an array prop) are out
of scope for v1, which is why the duplicate case is an error rather than a
merge.

## `<for>`

| Written | Lowers to |
|---|---|
| `<for\|item, i\| of=xs()>` | `<For each={xs()} keyed={false}>{(item, i) => body}</For>` |
| `<for\|item, i\| of=xs() by="id">` | `<For each={xs()} keyed={x => x.id}>{(item, i) => body}</For>` |
| `<for\|k, v\| in=obj()>` | `<For each={Object.entries(obj())} keyed={e => e[0]}>{([k, v]) => body}</For>` |
| `<for\|i\| from=a to=b>` | `<Repeat count={(b) - (a) + 1} from={a}>{(i) => body}</Repeat>` (`from` omitted when the author didn't write it) |
| `<for\|i\| from=a until=b>` | `<Repeat count={(b) - (a)} from={a}>{(i) => body}</Repeat>` |
| `<for\|i\| from=a to=b step=s>` (all three literals) | `<Repeat count={N}>{(mxIndex) => { const i = (a) + mxIndex * (s); return body; }}</Repeat>` — `N` folded at compile time |
| `<for\|i\| from=a to=b step=s>` (any of the three dynamic) | `<Repeat count={Number.isFinite(Math.max(0, Math.floor(((b)-(a))/(s))+1)) ? Math.max(0, Math.floor(((b)-(a))/(s))+1) : 0}>{(mxIndex) => { const i = (a) + mxIndex * (s); return body; }}</Repeat>` |
| `<for\|i\| from=a until=b step=s>` | same, with `Math.ceil(((b)-(a))/(s))` (exclusive bound) |
| `<for\|i\| ... step=0>` (literal) | parse error: `step must not be 0` |
| `<for\|i\| ... step={s()}>` where `s()` returns `0` at runtime | not a parse error (the value isn't known until runtime) — `count` evaluates to `Infinity`/`NaN`, caught by the `Number.isFinite` guard above and clamped to `0` rows, not an infinite `Repeat` |

**`from=`/`to=`/`until=`/`step=` are read once per row when `step=` is
present, not once for the whole range.** Without `step=`, `Repeat`'s own
`from`/`count` props are each read once (as any JSX attribute is). With
`step=`, the emitted callback recomputes `i = from + mxIndex * step` on
*every row* — `Repeat` calls that callback once per row — so an N-row range
evaluates `from`/`step` N+1 times at runtime (once in `count`, once per row).
A signal read or a literal is unaffected by this, but an impure expression
(a call with a side effect, a mutating counter) silently runs N+1 times
instead of once. Keep `from=`/`to=`/`until=`/`step=` pure — a signal, a
literal, or a memo — the same requirement any JSX attribute value already
has under Solid's re-read-on-every-access model. See
`packages/mx-parser/src/mx/control.ts`'s `steppedRepeatElement` for the
lowering itself.

**A dynamic `step=` that evaluates to 0 at runtime clamps to 0 rows, never
an infinite `Repeat`.** A literal `step=0` is a parse error, but `step=`
can be any expression (`step={s()}`), so a runtime value of 0 cannot be
caught at parse time — `(bound - from) / 0` is `Infinity` (or `NaN` for
`0 / 0`), and handing `Infinity` to `Repeat`'s `count` would try to render
an unbounded number of rows. The non-literal-folded `count` expression is
therefore wrapped in `Number.isFinite(…) ? Math.max(0, …) : 0`, not bare
`Math.max(0, …)` — `Math.max` alone passes `Infinity`/`NaN` straight
through, since neither compares as less than `0`.

The stepped callback's raw counter is a hygienic synthetic name, `mxIndex`
by default, bumped to `mxIndex2`/`mxIndex3`/… if **either** the author's own
`|i|` param name **or** their body already references `mxIndex` — checking
the body alone would let `<for|mxIndex| from=0 to=9 step=1>` emit `(mxIndex)
=> { const mxIndex = ...; ... }`, a duplicate declaration shadowing the very
param it reads from. Either way, the author's own `|i|` param name is always
what the body sees as the loop variable, never the synthetic counter.

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
