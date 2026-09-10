# mx-site

A demo of standalone MX (`@markox/html`) — `.mx` templates compiled to
string-returning TypeScript modules, served two ways: a real Hono-on-Bun
server, and a static build. No client runtime, no Solid; both targets render
the exact same `src/pages/*.mx` templates.

## What it demonstrates

| route | exercises |
|---|---|
| `/` | the shared layout via an attribute-tag named block (`<@header>` pattern), a partial via `import`, `<!doctype html>`, head/meta |
| `/list` | `<for>` over a collection (index form and a plain-object form), `<if>`/`<else>` for the empty-state case, `<const>` |
| `/form` | static, dynamic, boolean and spread attributes; escaping of user-supplied `<`, `&`, `"`, `'` |
| `/mixins` | `<define>` with args called more than once, and a `<define>` taking a block |
| `/raw` | `$!{}` raw output beside `${}` escaped output on the same data |

Every page is wrapped in `src/pages/layout.mx`, so the layout/partial pattern
runs on every route, not just `/`.

Every component tag in this app is capitalized (`<Layout>`, `<Callout>`).
The emitter decides component-vs-HTML-element dispatch by the tag name's
first character: `A`-`Z` calls it as a component, anything else emits it as a
literal HTML element — so `<layout ...>` (lowercase) silently renders as an
unknown custom element instead of calling the imported component, with no
error. The intended rule, ruled on but not yet implemented, is that a tag
name matching an in-scope binding (an `import` or a `<define>`) is a
component call regardless of case; only a name matching neither is an HTML
element. Until that lands, capitalize every component/define tag you call.

`<for>`'s `by=` attribute (identity/custom keying) is not supported by
`@markox/html`'s emitter and is silently dropped if written — not just here,
`/list` does not use it. Keying exists to let a diffing renderer reuse DOM
nodes across re-renders; standalone MX renders once to a string with no
reconciliation to key against, so there is nothing for `by=` to do. (A
parallel change is making this a parse error rather than a silent no-op.)

## Compiling `.mx` to a runnable module

`compile(source, filename)` from `@markox/html` returns TypeScript source
text, not a runnable module — it still has `import Layout from "./layout.mx"`
in it, which Bun cannot resolve directly. `src/compile-pages.ts` walks
`src/pages/**/*.mx`, compiles each file, rewrites its relative `./x.mx`
imports to `./x.mx.ts`, and writes the result to `.gen/pages/` (gitignored,
like `dist/`). Both `bun run dev` and `bun run build` call `compilePages()`
first and import from `.gen/pages/`, so the server and the static build run
the identical compiled output — nothing is forked between them.

## Running it

```
bun run dev     # Hono on Bun, http://localhost:5173
bun run build   # writes dist/*.html
bun run e2e     # Playwright against both the dev server and dist/
```

`bun run e2e` needs `bunx playwright install chromium` once.

## A tsconfig quirk this example works around

`packages/mx-html/tsconfig.json` maps `@markox/parser` to
`../mx-parser/src/public.d.ts` in its `paths` for typechecking. Bun's `bun
run` also honours `tsconfig.json` `paths` at runtime, and it resolves that
mapping for *any* file under `packages/mx-html/`, regardless of which script
is the entry point — so a plain `bun run` of anything that imports
`@markox/html` fails with `Export named 'X' not found in module
".../public.d.ts"` (a `.d.ts` has no runtime exports). This example's `dev`
and `build` scripts route around it with `bun run
--tsconfig-override=../../tsconfig.base.json`, which points Bun at a
tsconfig with no such `paths`. This is a property of `mx-html`'s tsconfig,
not of this example or of `@markox/html`'s compiler — see the brief report
for the full writeup.
