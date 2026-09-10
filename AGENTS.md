# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn. Toolchain versions are pinned in `.prototools` (`bun`, `moon`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- typecheck, then lint, then build, then test; stops on first failure
bun run build       # or: moon run mx-parser:build -- builds packages/mx-parser to dist/
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root — so pick one command style (bun or moon) per invocation rather than mixing them.

## Edit check hook

`.claude/hyper.json` runs Biome formatting checks, then per-package TypeScript type checking via `tsc --noEmit` after every agent edit. Both commands use `./node_modules/.bin` paths directly so they work without shell shims (proto/bun/nvm wrappers).

## Exact-pin policy

All dependencies in the root `package.json` are pinned to an exact version (no `^`/`~`). `mx-parser`'s output must be byte-reproducible wire format across the parser, the Babel plugin, and the TS plugin's virtual-file generator; an unpinned transitive bump in Babel or TypeScript could silently change AST shape or emitted output. See `README.md` "Pinned versions" for the current set and rationale.

## Solid 2 target and pin policy

SolidMX targets **Solid 2 only** — no Solid 1 lowering table, no dual target. Pins: `solid-js`, `@solidjs/web`, `@solidjs/babel-plugin`, `@solidjs/compiler` all at `2.0.0-rc.7`. `babel-preset-solid` and `vite-plugin-solid` are dead ends (renamed upstream).

Solid 2 is pre-stable and RCs ship weekly. Policy: **pin one RC and stay on it**; re-sync the research note on each bump we choose to take, and do not chase every RC. See `README.md` "Solid 2 RC policy".

Consequences encoded in the lowering table: `Index`/`Key`/`mxRange` are gone (one `For` with a `keyed` prop, plus `Repeat`); `classList` is gone (one `class` prop taking a string, object, or recursive array); `on:`/`oncapture:`/`attr:`/`bool:`/`use:` are parse errors with fix-it hints (only `prop:` survives); `<try>` lowers to `Errored`/`Loading`. No runtime-helper imports and no `needsImport` machinery: both compilers auto-import the builtIns (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`).

## Base branch

`main`.

## Commit convention

Conventional commits: `type(scope): summary`.

## MX parser

`packages/mx-parser` vendors `@babel/parser` 7.29.8 and forks one method of its JSX plugin so `<` in expression position is parsed as MX. Entry points:

- `parse(source, filename, options?)` — parses `.solid.mx`, returns a Babel `File` of standard node types only (MX facts go in `node.extra.mx`).
- `parseBabel` / `parseBabelExpression` — the untouched vendored `@babel/parser` surface, for plain `.ts`/`.tsx`.

MX parsing is opt-in through the `mx` parser option, which `parse` sets. Without it the vendored parser is byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, so keep those tests on `parseBabel` rather than `parse`. `packages/mx-parser/UPSTREAM.md` "Local modifications" records exactly what the fork changed.

Consumers typecheck against `src/public.d.ts`, not `src/index.ts`: the vendored tree needs tsconfig relaxations that must not leak into packages that merely call `parse`.

Two syntax decisions are settled and encoded in the lowering table:

- **Whitespace follows Marko, not JSX.** A whitespace-only text run containing a newline is dropped entirely, so indented markup renders nothing between children; a whitespace-only run without a newline collapses to one space. `${" "}` is the escape hatch. Comments are dropped from the output and do not count as content when trimming.
- **Void elements need no slash.** `<input value=x>` parses. The set (`area base br col embed hr img input link meta param source track wbr`) is declared to htmljs-parser as `TagType.void`; a void tag written with a closing tag is a parse error.
- **Shorthand `class` merges with a string or an object; anything else is a parse error.** Shorthand plus a *string* `class="x"` merges to `class="card x"` (shorthand first). Shorthand plus an **object literal** merges to Solid 2's array form, `class={["card", {...}]}`, the string entry always-on and the object toggling; a static `class="x"` present as well folds into that string entry (`class={["card x", {...}]}`) rather than being emitted as a second `class` attribute. Shorthand plus any *other* dynamic `class=` expression (an identifier, a call, a ternary) is a parse error. `#id` shorthand combined with an explicit `id=` is a parse error. `style=` only accepts an object-literal value (`style={color: c()}` → `style={{color: c()}}`); any other `style=` expression is a parse error for v1.
- **Tag params (`|a, b|`) come before `=value`.** `<if|u|=user()>`, not `<if=user()|u|>` — the latter parses but folds `|u|` into the condition expression and reports no params, matching `<for|item, i| of=...>`'s own order. `notes/solidmx-spec.md` §5.1 writes `<if=user()|u|>` as loose prose; the real grammar is params-first.

## Standalone MX (`.mx`) and `@markox/html`

MX has **two lowering targets in one parser package**, selected by a parse
option:

- `parse(source, filename)` — the default, `mxMode: "expression"`. A
  `.solid.mx` file: a TypeScript module in which `<` in expression position
  opens an MX element, lowered to Solid 2 JSX. Unchanged by template mode.
- `parse(source, filename, { mxMode: "template" })` — a whole-file `.mx`
  template, lowered to a string-returning TS module by `@markox/html`.

The two share the tokenizer but **not** the entry point.
`src/mx/walk.ts` (`walkMxRegion`) stops at the first element's close and hands
the tokenizer back to Babel; `src/mx/template.ts` (`walkMxTemplate`) owns the
whole file and never stops early. Keeping them separate is what makes template
mode additive — nothing in it runs for a `.solid.mx` parse, so the oracle
cannot move.

In template mode `parse` returns a `File` whose `program.body` is **empty** and
whose `extra.mxTemplate` holds the parsed template. A standalone template is
markup plus a few statement tags, not a TypeScript program, so there is no
honest Babel-node representation of it.

Two htmljs-parser facts that are easy to get wrong (both verified against
5.15.0, both cost real debugging time):

- **In concise mode `onOpenTagStart` never fires.** A line like
  `import Button from "./b.mx"` or `div.card` opens with the tag *name*, so
  `onOpenTagName` is the first event for the tag. A handler that assumes
  `onOpenTagStart` ran and bails on a null `pending` silently drops every
  concise-mode tag — including every statement tag.
- **`import` / `static` / `export` parse as *tags*, not statements.**
  htmljs-parser has no JS grammar, so `import Button from "./b.mx"` is a tag
  named `import` whose attributes are the remaining words. The tag's range is
  the statement's source span, so the text is sliced back out and re-parsed.
  They are declared `TagType.void` so the parser does not hunt for a close tag.

- **`<!doctype html>` reaches you only through `onDoctype`.** It fires no text
  or element event, so a handler set without `onDoctype` silently drops the
  doctype from a full HTML page. Template mode records it as a `doctype` child
  and emits it verbatim.

`@markox/html`'s emitter (`emit.ts`'s `emitElement`) decides component-vs-HTML
dispatch by **in-scope binding, not case**: a tag name matching an `import` or
a `<define>` is a component call whatever its case; anything else is an HTML
element whatever its case, hyphenated custom elements included. This is
Marko's own rule (custom tags are lowercase there), not an MX invention.
`import layout from "./layout.mx"` then `<layout>` calls the component;
`<my-widget>` with no matching binding stays a literal element. Before this
was resolved by binding, dispatch was a first-character `A`-`Z` check, so a
lowercase import or `<define>` name silently rendered as an unknown custom
element with the import never called — no error. A capitalized tag with no
matching binding is a compile error, not a literal element — no HTML element
is ever capitalized, so silently falling back to the element branch there
would reintroduce the same silent-misroute defect in the other direction. A
`<define>` shadows a same-named HTML element for the rest of the file
(`<define/section|x|>` makes `<section>` uncallable as a plain tag
afterward) — the define-before-import precedence in `emitElement` is
intentional, this is its consequence. Import binding names are extracted by
parsing the hoisted import line with `parseBabel` (default, namespace,
named, aliased, and combined forms), not by regex — a partial extraction
here is exactly the bug class this rule exists to fix. See
`packages/mx-html/fixtures-mx/lowercase-component` and `.../unknown-element`
for fixtures pinning both branches, and `fixtures.test.ts`'s "import binding
forms are recognised" and "unbound PascalCase tag is rejected" suites for
the rest. SolidMX's own PascalCase-means-component convention (`lower.ts`)
is unrelated and unchanged by this — it follows JSX, template mode is a
separate lowering path.

## Running tests in a fresh worktree

`@markox/parser`'s `main` is `dist/index.js`, so a freshly created worktree
needs `bun install` **and** `bun run build` before any dependent package's
tests will run — without `dist/` every consumer fails with "Failed to resolve
entry for package @markox/parser" (the oracle fails the same way). `bun run
verify` builds before it tests, so this only bites when running one package's
tests directly.

Per-package vitest runs need the root config: `bunx vitest run --root ../..
--project @markox/<name>`. A bare `bunx vitest run` inside a package directory
fails with "No projects were found", because `projects: ["packages/*"]` is
resolved relative to the root.

`packages/mx-html` (`@markox/html`) holds the string target:

- `escape(value)` — the *entire* runtime. Escapes `& < > " '`; `null` and
  `undefined` render as `""`, not their names.
- `compile(source, filename)` -> `{ code, map }`. The map is currently an
  identity placeholder: the emitter builds text directly rather than printing an
  AST, so there are no node positions to derive mappings from yet.

Emitted module shape: the `escape` import, the author's hoisted `import`s and
`static` blocks, their `export interface Input` verbatim, and
`export default function (input: Input): string` building one local by `out +=`
concatenation (**not** an array join — the goldens diff this code).

Whitespace is `normalizeText()` from `src/mx/lower.ts`, exported from the
parser and reused by both targets. Do not write a second implementation; that
is the whole point of exporting it.

Goldens live at `packages/mx-html/fixtures-mx/<name>/` with `input.mx`,
`input.json` and `expected.html`, and are asserted on **rendered HTML**, not on
emitted code, so the emitter stays free to improve. `biome.json` ignores
`**/fixtures-mx`.

## Zed extension

`packages/zed-extension` (`markox`) ships the `MX` language for Zed. It vendors
the unmodified `marko-js/tree-sitter` grammar by rev (in `extension.toml`) and
concatenates two upstreams' query files (`marko-js/tree-sitter`'s
`highlights.scm`/`injections.scm`, `marko-js/zed`'s `brackets.scm`/`outline.scm`
— the grammar repo ships neither of the latter two) plus `overlay/mx/*.scm`
into `languages/mx/*.scm` via `scripts/vendor.sh`. Never hand-edit those four
`.scm` files; edit the overlay or add a `patches/*.patch` and rerun the script.

`scripts/vendor.sh --check` compares the pinned revs against upstream HEAD and
exits non-zero on drift, without touching disk — the weekly
`.github/workflows/upstream-check.yml` job runs it and opens a PR when it
finds drift. `tree-sitter` is not on PATH on the operator's machine; the CLI is
pinned as an exact-version devDependency (`tree-sitter-cli`) and invoked via
`bunx --package tree-sitter-cli@<pin>`, never a bare `tree-sitter`.

No Rust: the extension has no `Cargo.toml`/`src/lib.rs` and no
`[language_servers.*]` block — Zed only requires Rust when `Cargo.toml`
exists, and dropping the (MX-unaware) `@marko/language-server` install is what
makes that possible. See `packages/zed-extension/README.md` and `UPSTREAM.md`.

`SolidMX` (`.solid.mx`) is a separate, not-yet-implemented language sharing
this extension id — do not add it here without also wiring
`packages/tree-sitter-solidmx`'s grammar. Note: Zed's suffix matcher computes a
file's "extension" as the text after the *last* dot, so `Foo.solid.mx` matches
`path_suffixes = ["mx"]` just like `Foo.mx` does — `.solid.mx` will only
correctly resolve to `SolidMX` once that language's own config declares the
longer `path_suffixes = ["solid.mx"]`, which wins by matched-length precedence.

## Design docs

Design docs, specs, and research notes live outside this repo, at the project space root under `notes/` (not inside this worktree).

## Oracle harness

`packages/oracle` (`@markox/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, across **both Solid 2 backends and both generate variants** — four rows per fixture. `bun run oracle` runs it standalone and prints a fixture/backend/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

Backends (`compile.ts`'s `backend: "babel" | "native"`):

- `babel` — `@solidjs/babel-plugin`, the `babel-preset-solid` successor, over a Babel JSX AST via `parserOverride`.
- `native` — `@solidjs/compiler`, Solid's Oxc compiler and `@solidjs/vite-plugin`'s default. Its only entry point is `transform(code, options)` over **source text**, so MX reaches it by printing its lowered AST back to JSX text first. Both backends must pass: they are separate codegen implementations.

Variant names are unchanged from Solid 1 (`generate: "dom" | "ssr"` plus `hydratable`) — both 2.0 packages document the same spelling.

Two native-compiler gotchas, worked around in `compile.ts`:

- The documented `syntax` option (README and `types.d.ts`) is **rejected at runtime** by rc.7. Frontend routing is by filename.
- The compiler picks its parser dialect from the **filename extension** and rejects `.solid.mx`. The oracle appends `.tsx` to MX filenames for that backend, like `@markox/vite-plugin`'s virtual id.

`@markox/parser` exports two printer entry points, both sharing one set of `@babel/generator` options so they cannot drift: `print(source, filename)` for the ordinary case, and `printAst(ast, filename)` for callers that must run their own pass over the AST first. The oracle needs the second one — `.solid.mx` fixtures use TypeScript syntax, `@babel/preset-typescript` has to erase it before printing, and `print` would re-parse the source and skip that erasure, handing `interface Todo { ... }` to a JSX-only frontend.

A twin must not introduce whitespace MX drops. MX follows Marko's rules — a whitespace-only run containing a newline is dropped — so `text<p>…` goes on one line in the twin wherever the MX source separates them only by indentation. See `fixtures/README.md`.

`@markox/parser` is wired into the harness (`packages/oracle` depends on it and `report.ts` passes its `parse` as `mxParser`), so fixtures compile for real. Statuses: `pass`, `fail` and `divergent` mean the parser ran; `skipped` means no parser was available (now a real failure, not "not implemented"); `pending` means the fixture carries a `PENDING` marker naming constructs the parser cannot lower yet. Neither `skipped` nor `pending` is a pass, and `--strict` fails the run on either — see `fixtures/README.md` for the `PENDING` contract.

Current state: `counter`, `todos`, `attrs` and `lists` all pass on both backends and both variants (16 rows). `bun run oracle` and `bun run oracle -- --strict` are both expected to exit 0 — `--strict` green is the standing bar, not an aspiration.

`packages/oracle/src/compile.ts` runs `@babel/preset-typescript` after parsing `.solid.mx` too, not only `.tsx`: the vendored MX parser accepts TS syntax (interfaces, type annotations, generics) but `mxParser`'s `parserOverride` only replaces the *parse* step, not the erasure pass, so TS type nodes are still in the AST afterward and need the same stripping a `.tsx` file gets — or they leak into the compiled output and break byte parity against a twin that went through the ordinary TS pipeline.

Golden snapshots (`fixtures/<name>/__golden__/twin.<backend>.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a Solid 2 pin bump changing generated code. Regenerate them deliberately with `bun run oracle -- --update` and call it out in the PR — never let a pin bump change them as a silent side effect.

`packages/mx-parser/src/mx/perf.test.ts`'s 500ms wall-clock budget only fails the test when `MX_PERF_STRICT` is set; otherwise it just `console.warn`s past the budget, since a plain `bun run verify` under machine contention (several agents/verifiers at once) can blow well past 500ms with no actual parser regression.

## Vite plugin

`packages/mx-vite-plugin` (`@markox/vite-plugin`) is the primary integration
(spec section 7.1): an `enforce: "pre"` Vite transform that prints
`.solid.mx` to JSX source text with `print()` ahead of
`@solidjs/vite-plugin`. Both plugins are `enforce: "pre"`, so their relative
order is their order in the `plugins` array — `mx()` must come first.

`resolveId` rewrites the resolved path to `<path>.solid.mx.tsx` and `load`
reads the real file from disk. That suffix is not cosmetic; three separate
stages dispatch on the file extension and `.solid.mx` satisfies none of them:

1. Vite routes a module into the JS pipeline only when the extension matches
   `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). With no `resolveId` hook the
   import is never resolved and `transform` never runs at all.
2. Rolldown picks its parser dialect from the extension, so printed JSX is
   parsed as plain JS ("Unexpected JSX expression"). Returning
   `moduleType: "tsx"` fixes the parse but then hands the module to
   rolldown's own JSX transform, which resolves `react/jsx-runtime`.
3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, default
   `src/**/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`. That test runs *before* its
   `options.extensions` list is consulted, so registering `.solid.mx` there
   cannot bring the file back in.

The `.tsx`-suffixed id satisfies all three at once, which is why the
example's `vite.config.ts` is just `plugins: [mx(), solid()]` with no Solid
configuration.

The suffixed path is produced by Vite's own resolver, never by path
arithmetic in the plugin: `resolveId` calls `this.resolve(id, importer,
{ skipSelf: true })` and appends the suffix to whatever comes back. That is
what makes relative ids from nested importers, root-relative (`/src/x.solid.mx`)
and `/@fs/` ids, `resolve.alias` entries and bare specifiers into workspace
packages all work; computing the path locally got each of those wrong. Any
`?query` on the id is re-attached after the suffix, so `./A.solid.mx?raw`
still returns the file's text rather than the compiled module.

`load` claims the suffixed id only when the un-suffixed `.solid.mx` file
actually exists on disk. A real `Foo.solid.mx.tsx` checked into a project is a
different module and must not be shadowed by MX's virtual one, so when there is
no `Foo.solid.mx` beside it the hook returns null and Vite reads the real file. Diagnostics and source maps keep the original `.solid.mx`
filename: `transform` prints against the stripped path, and parse errors are
re-raised with a Vite-shaped `loc` (`{ file, line, column }`) so the overlay
points at the MX line.

`@markox/parser`'s `main` is `dist/index.js`, not `src/index.ts`. Vite's config
loader externalizes bare imports, so a consumer that pulls the parser's TS
source makes Node load the vendored Babel tree, whose `const enum`s the
strip-only TypeScript loader rejects. `types` still points at
`src/public.d.ts`, so typechecking never needs a build; `bun run verify`
builds before it tests.

## Examples

`examples/counter-app` is a Solid 2 app whose components are `.solid.mx`.
`examples/todomvc` is the canonical TodoMVC app (todomvc.com spec), also
entirely in MX: `App.solid.mx` (state, hash-routed filter, localStorage
persistence), `TodoItem.solid.mx` (toggle, double-click-to-edit, destroy),
`Footer.solid.mx` (count, filters, clear-completed). Root `package.json`
`workspaces` includes `examples/*`, so `@markox/vite-plugin` and
`@markox/parser` resolve as workspace deps, and root `typecheck` covers
`examples/*/` as well as `packages/*/`.

Solid 2's `createEffect` requires **two** arguments — a compute function and
an effect function (`createEffect(() => signal(), value => doWork(value))`).
The single-callback Solid 1 form (`createEffect(() => { ... })`) throws
`MISSING_EFFECT_FN` at runtime and halts the reactive system. This is a Solid
2 API change, not an MX lowering issue — MX passes `createEffect` calls
through untouched.

```
cd examples/counter-app
bun run dev        # dev server
bun run build      # production build
bun run e2e        # headless Chromium against dev server + built output
```

`bun run e2e` needs `bunx playwright install chromium` once. It is wired to
the example's own vitest config (`e2e/vitest.config.ts`) and is deliberately
outside the root `bun run test`, whose `projects` glob is `packages/*`.

`e2e/resolve.spec.ts` is left out of that config and run on demand with
`vitest run --config e2e/vitest.config.ts e2e/resolve.spec.ts`: all four of its
assertions pass, but closing a Vite dev server inside vitest never settles, so
the file reports a hook timeout after two minutes. The hang is in that
teardown, not in the plugin — the same `server.close()` returns in ~1ms outside
vitest, and `counter.spec.ts`/`hmr.spec.ts` close their own dev servers in
seconds.

Pin policy for examples: an example pins its own Solid 2 RC versions exactly
in its own `package.json` (`solid-js`, `@solidjs/web`, `@solidjs/vite-plugin`),
independent of the root pins, which still track Solid 1 for the oracle's
`babel-preset-solid` comparison. Root and example pins are expected to
disagree; do not "fix" one to match the other.

Type-checking `.solid.mx` imports from `.tsx` relies on the ambient
`src/mx.d.ts` declaration in the example. It types every MX export as a Solid
component; real per-export types arrive with `@markox/typescript-plugin`'s
virtual-`.tsx` projection (spec section 7.2).

`examples/mx-site` is a plain-string example: a Hono-on-Bun server and a
static build both rendering `.mx` templates via `@markox/html`'s `compile()`,
no Solid, no client runtime. `compile()` returns a TS module whose imports are
still `./x.mx` (not runnable as-is), so the example's `src/compile-pages.ts`
compiles every page and rewrites those imports to the generated `./x.mx.ts`
sibling under `.gen/` before either the dev server or the static build
imports them.

`packages/mx-html/tsconfig.json` maps `@markox/parser` to
`../mx-parser/src/public.d.ts` in its `paths`, for typechecking against the
parser's public types without requiring `dist/` to be built first. Bun's
`bun run` also honours `tsconfig.json` `paths` at runtime, and does so per
imported file's own directory, not just the entry point's — so a plain `bun
run` of any script that imports `@markox/html` (which imports
`@markox/parser`) fails with `Export named 'X' not found in module
".../public.d.ts"`, because Bun resolves the bare `@markox/parser` specifier
against `packages/mx-html/tsconfig.json`'s `paths` regardless of where the
importing file lives. Work around it with `bun run
--tsconfig-override=<path to a tsconfig with no such paths>`; `examples/mx-site`'s
`dev` and `build` scripts do this against the root `tsconfig.base.json`. This
is a property of `mx-html`'s tsconfig, not a bug in `@markox/html` itself or
in Bun's resolver generally — vitest is unaffected because it does not resolve
bare specifiers through `tsconfig.json` `paths` the same way.
