# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn. Toolchain versions are pinned in `.prototools` (`bun`, `moon`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- delegates straight to `bun run verify`, see below
bun run build       # or: moon run mx-parser:build -- builds packages/mx-parser to dist/
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root — so pick one command style (bun or moon) per invocation rather than mixing them. `verify` is the one exception: moon's `verify` task is a single `bun run verify` command, not a `deps` list, because `bun run verify`'s own chain (pre-verify must run before test; the coverage script must run last, after everything else) isn't expressible as an unordered `deps` set — delegating keeps the two entry points from silently drifting into two different definitions of "verified".

## Test Coverage Verification (decision 64)

`verify` (`bun run verify` / `moon run :verify`) proves every non-exception
package's tests actually **ran in that invocation** — not merely that some
test wiring exists for it. The chain is:

```
scripts/pre-verify.ts && typecheck && lint && build && test && test:bun && test:grammar && scripts/verify-coverage.ts
```

- `scripts/pre-verify.ts` deletes any evidence left over from a previous run
  (`vitest-results.json`, `packages/tree-sitter-solidmx/.test-ran`) and writes
  `.verify-start` with the current time. All three are gitignored.
- `bun run test` runs vitest (over the root `projects: ["packages/*"]`
  config, which auto-discovers a project per package with test files) with
  `--reporter=json --outputFile=vitest-results.json`.
- `bun run test:grammar` runs `moon run tree-sitter-solidmx:test --force`
  (`tree-sitter-solidmx`'s real test is `scripts/test.sh`, not vitest, so it
  can never appear in the JSON report). `scripts/test.sh` writes
  `.test-ran` as its last step, only on success; `--force` bypasses moon's
  own task cache so a cached "already ran, nothing changed" result can't be
  mistaken for evidence from *this* run.
- `scripts/verify-coverage.ts` (the last step) enumerates all workspace
  packages (`packages/*`, `examples/*`), and for each non-exception package
  reads the evidence directly: a package name parsed out of
  `vitest-results.json`'s test file paths, or (for `tree-sitter-solidmx`
  only) the `.test-ran` marker. Every evidence file's mtime must be `>=`
  `.verify-start`'s timestamp, or it's treated as stale and the package
  fails — there is no code path that marks a package as tested without
  reading its evidence file. Prints a table: package | test wiring | ran,
  and exits non-zero if any non-exception package has no fresh evidence.

Exception packages (no unit test wiring required; verified elsewhere):
- `examples/counter-app` — e2e only
- `examples/mx-site` — e2e only
- `examples/mx-vite` — e2e only
- `examples/todomvc` — e2e only
- `packages/zed-extension` — grammar only, build verified in CI

Any new package without test wiring must be added to the exception list with
a documented reason, or get a vitest project (a package under `packages/*`
or `examples/*` with its own test files) that emits into
`vitest-results.json`.

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
- **Tag params and attribute tags are generic, not control-tag-only**
  (decision 51). `<Tag|p1, p2|>body</Tag>` lowers to
  `<Tag>{(p1, p2) => body}</Tag>` for *any* tag — components and HTML
  elements alike — which is what lets Solid's own render-prop components be
  called from MX (`<For|item, i| each=xs()>`, `<Show|u| when=user()>`).
  A function child on a DOM element has no meaning in Solid; MX lowers it
  anyway rather than inventing a rule the target does not have. Inside any
  tag, `<@name>body</@name>` becomes the prop `name={body}` on the parent,
  and `<@name|p|>` becomes `name={(p) => body}`; ordinary children stay
  `children`, and props are emitted as the parent's own attributes in source
  order followed by the attribute tags in source order. `<try>` is expressed
  *on top of* this: `lowerTry` reads `<@catch>`/`<@placeholder>` out of the
  same `collectAttributeTags` every other tag uses, so the special and
  generic paths cannot drift. Control tags take no attribute tags other than
  `<try>`'s two. An attribute tag whose name is already an attribute on the
  parent is a parse error rather than a second `name=` the last writer wins —
  and `children` counts, since ordinary children lower into that prop, so
  `<@children>` beside any ordinary child collides too. The params callback's
  body range is measured over the *stripped* children (the `<@name>` ones
  consumed into props are gone), or the arrow's `loc` overruns into text that
  belongs to a prop: right JS, wrong source map. The still-unsupported
  construct `mx.test.ts` uses to exercise the LowerError-to-SyntaxError path
  is now the dynamic tag name (`<${x}>`), not an attribute tag.
- **Tag params (`|a, b|`) come before `=value`.** `<if|u|=user()>`, not `<if=user()|u|>` — the latter parses but folds `|u|` into the condition expression and reports no params, matching `<for|item, i| of=...>`'s own order. `notes/solidmx-spec.md` §5.1 writes `<if=user()|u|>` as loose prose; the real grammar is params-first.

## `.mx` is the official extension; `.marko` is an alias (decision 72)

Decision 68 retired the old `.mx` *dialect* (required explicit imports,
`<fragment>`, required `export interface Input`, lowercase-by-scope) —
`@markox/html` and `packages/mx-html` stay deleted, and those conventions do
not come back. Decision 72 re-establishes `.mx` as MX's own **identity**,
distinct from that dialect: MX is its own language with Marko as its origin,
and MX 1.0 is a strict subset of Marko syntax — every MX 1.0 file is a valid
Marko file with the same meaning for the structural core. `.mx` is the
official extension; `.marko` is accepted everywhere with identical
treatment, so porting a Marko component to MX is a rename or nothing.
`.solid.mx` is unaffected — a different file kind (TSX with MX regions), not
covered by this alias.

- `parse(source, filename)` in `@markox/parser` — a `.solid.mx` file: a
  TypeScript module in which `<` in expression position opens an MX element,
  lowered to Solid 2 JSX. This is the parser package's only mode; there is no
  `mxMode` option. SolidMX is a separate host from the vanilla one below, and
  is not affected by either the `.mx`/`.marko` alias or decision 68's dialect
  retirement.
- `compile(source, filename)` in `@markox/translator` — a whole-file MX
  template (`.mx` or its `.marko` alias, both stock Marko syntax with no
  dialect layered on top). `@marko/compiler` parses, validates and supplies
  the tag registry; the package supplies only a translator
  (`packages/translator/src/translate.ts`) and its own taglib
  (`packages/translator/taglib/marko.json`). `@markox/parser` is not on this
  path at all. The Bun loader (`@markox/translator/bun`) and
  `@markox/vite-plugin`'s `mx()` both accept `.mx` and `.marko` identically,
  excluding `.solid.mx`.

Four Marko facts that are easy to get wrong (all measured against
`@marko/compiler` 5.42.5, all cost real debugging time):

- **Marko's `onText` already implements decision 33.** `<p>\n  a\n</p>` gives
  `MarkoText "a"` — a whitespace-only run containing a newline is dropped —
  and `a   b` gives `"a b"`. The string translator therefore does **not**
  re-normalize, and does not call `normalizeText()`. Do not add a second
  normalization pass on that path; it would double-collapse.
- **`import` / `static` / `export` parse as *tags*, not statements**, whose
  attributes are the remaining words. To recover the statement text, slice by
  **`loc` line/column**: `start` and `end` are **`undefined`** on these nodes.
  (An earlier version of this file said "the tag's range is the statement's
  source span" — true of `loc`, not of `start`/`end`.) Import binding names
  are then re-parsed with `parseBabel`, never regex-scraped.
- **A bare top-level `${expr}` line is a `MarkoTag` whose `name` is the
  expression**, not a `MarkoPlaceholder` — concise mode has no other shape for
  it. A tag with an expression name, no attributes and no body is that
  placeholder; treating every expression-named tag as a dynamic tag error
  breaks a template whose first content is a placeholder.
- **`<!doctype html>` arrives as a `MarkoDocumentType` node** whose `value` is
  `doctype html` (delimiters stripped), so it is re-emitted as `<!${value}>`.
  Marko strips comment delimiters too, which is why an HTML comment and a `//`
  line comment are told apart by re-reading the source at the node's `loc`.

`@markox/translator`'s translator (`translate.ts`'s dispatch) decides
component-vs-HTML dispatch by **in-scope binding, not case**: a tag name
matching an `import`, a `<define>`, or a tag Marko discovered via taglib/
`tags/` is a component call whatever its case; anything else is an HTML
element (Marko's own registry) whatever its case, hyphenated custom elements
included. This is Marko's own rule (custom tags are lowercase there), not an
MX invention. `import layout from "./layout.marko"` then `<layout>` calls the
component; `<my-widget>` with no matching binding stays a literal element. A
capitalized tag with no matching binding is a compile error, not a literal
element — no HTML element is ever capitalized. Import binding names are
extracted by parsing the hoisted import line with `parseBabel` (default,
namespace, named, aliased, and combined forms), not by regex. An unbound
*lowercase* tag that is neither hyphenated nor a real HTML/SVG/MathML element
is a translate error naming it, rather than silently rendering as an unknown
custom element. SolidMX's own PascalCase-means-component convention
(`lower.ts`) is unrelated and unchanged by this — it follows JSX, and is a
separate host on a separate lowering path.

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

`packages/translator` (`@markox/translator`) holds the string target:

- `escape(value)` — the *entire* runtime. Escapes `& < > " '`; `null` and
  `undefined` render as `""`, not their names.
- `compile(source, filename, options?)` -> `{ code, map }`, driving the
  translator under `@marko/compiler`. `options.strict` swaps in `strictPolicy`
  (see the translator section below). The map is currently an identity
  placeholder: the translator builds text directly rather than printing an
  AST. Marko's nodes do carry real `loc`, so genuine mappings are now
  possible — a separate task.
- `TranslateError` — a construct that parses as Marko but has no string
  lowering, carrying `line`/`column` rather than byte offsets, because that is
  what Marko's nodes have.

Emitted module shape: the `escape` import, the author's hoisted `import`s and
`static` blocks, their `export interface Input` verbatim, and
`export default function (input: Input): string` building one local by `out +=`
concatenation (**not** an array join — the goldens diff this code).

Whitespace on the **SolidMX** path is `normalizeText()` from
`src/mx/lower.ts`, exported from the parser. Do not write a second
implementation for that target. The **string** target does not use it at all:
Marko's own `onText` already applies the same decision-33 rule before the
translator sees a `MarkoText` (see the four Marko facts above), so calling
`normalizeText()` there would collapse twice.

Goldens live at `packages/translator/fixtures-marko/<name>/` with
`input.marko`, `input.json` and `expected.html`, and are asserted on
**rendered HTML**, not on emitted code, so the emitter stays free to improve.
`biome.json` ignores `**/fixtures-marko`.

## Zed extension

`packages/zed-extension` (`markox`) ships two languages for Zed: `MX`
(`.mx`, restored per decision 72) and `SolidMX` (`.solid.mx`).

`MX` rides Marko's own unmodified tree-sitter grammar (`[grammars.marko]` in
`extension.toml`, pinned to the same rev the official `marko-js/zed`
extension pins: `7fb20382b9b0c97c8bdbceee0e0641bea11dd00f`,
`@marko/tree-sitter` v0.2.0). `languages/mx/*.scm` are the official
extension's `languages/marko/*.scm` copied **verbatim**, no overlay, no
edits — MX 1.0 being a strict Marko subset (decision 72) means Marko's own
queries already apply. `languages/mx/config.toml` is hand-written (`name =
"MX"`, `path_suffixes = ["mx"]`) since the official file's `name = "Marko"`
would collide with the official extension's own language if copied as-is.
`.marko` files are covered by installing Zed's official `marko-js/zed`
extension directly (its own `Marko` language, unrelated to `MX`); do so
alongside `markox` for the SolidMX injection to highlight (see below). `MX`
has no language server of its own: Marko's LS (from the official extension)
binds to its own `Marko` language, not `MX`, since Zed's
`[language_servers.*]` binding is per-language-name.

**Zed suffix precedence.** Zed's suffix matcher takes the text after a
file's *last* dot, then the longest matching `path_suffixes` entry wins.
`MX` declares `["mx"]`; `SolidMX` declares `["solid.mx"]` — both match
`Counter.solid.mx`, and `SolidMX`'s longer entry wins, so `.solid.mx` keeps
resolving to `SolidMX` regardless of `MX` being present. Verified by
inspection: `languages/solidmx/config.toml` already declared the longer
`path_suffixes = ["solid.mx"]` before `MX` was added back, so no change was
needed to preserve this precedence.

`SolidMX` (`.solid.mx`) is backed by `packages/tree-sitter-solidmx`'s grammar
(a patched `tree-sitter-typescript` tsx dialect with an `mx_element` external
token in expression position). Its grammar is a **`file://` dependency during
development** (`extension.toml`'s `[grammars.solidmx]`, with
`path = "packages/tree-sitter-solidmx"` since the grammar lives inside this
monorepo rather than at a repo's own root) — swapped to a real GitHub URL at
publish time. Even `file://` still requires a **committed sha**: Zed's
`checkout_repo` runs `git init` + `git fetch --depth 1 origin <rev>` +
`git checkout <rev>` regardless of scheme, so uncommitted changes under
`packages/tree-sitter-solidmx` are invisible to Zed. The dev loop is commit,
then bump `rev` in `extension.toml`, then reinstall — see
`packages/zed-extension/README.md`.

`languages/solidmx/*.scm` are generated by `scripts/vendor.sh`:
`highlights.scm` is copied from
`packages/tree-sitter-solidmx/queries/highlights.scm` (a local sibling
package, not a network fetch); `injections.scm`/`brackets.scm`/`outline.scm`
have no upstream reference extension to copy from (no `marko-js/zed`
equivalent exists for this grammar), so their base content is hand-authored
in `base/solidmx/*.scm` instead. All four get `overlay/solidmx/*.scm`
concatenated on top. Never hand-edit `languages/solidmx/*.scm` directly.
There is no `vendor.sh --check` mode (MX's version had one, comparing its
`marko-js/tree-sitter`/`marko-js/zed` pins against upstream HEAD): SolidMX's
highlights source is local, with no upstream HEAD to drift against, so a
"check" mode could only ever report success — decision 55, a gate that
cannot fail is not a gate. `.github/workflows/upstream-check.yml`'s
`vendored-files-match` job does the real check instead.

No Rust: the extension has no `Cargo.toml`/`src/lib.rs` and no
`[language_servers.*]` block — Zed only requires Rust when `Cargo.toml`
exists. See `packages/zed-extension/README.md` and `UPSTREAM.md`.

`base/solidmx/injections.scm` injects a language named `marko` into
`mx_element` regions (MX and SolidMX share syntax) — the region is a single
opaque external token, so nothing inside it is captured by SolidMX's own
queries. This package's own `MX` language is named `"MX"`, not `"Marko"`, so
it cannot satisfy the injection despite compiling the same grammar — the
injection resolves, and only then does the region get any syntax
highlighting, when Zed's official `marko-js/zed` extension (`name = "Marko"`
in its `languages/marko/config.toml`, matched case-insensitively) is also
installed; without it the region stays unhighlighted plain text. This is a
documented prerequisite, not a bug (see `packages/zed-extension/UPSTREAM.md`
"SolidMX injection prerequisite").

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

### `oracle:marko`: Marko parity for the stock `.marko` fixture set

Decision 51: the parity target for Marko-syntax constructs is Marko itself,
not Solid. Decision 68 retired `.mx`/`@markox/html`, so there is one dialect
and one table: `bun run oracle:marko` (`packages/oracle/src/report-marko.ts`,
delegating to `report-marko-stock.ts`) renders every fixture under
`packages/translator/fixtures-marko/<name>/{input.marko,input.json,expected.html}`
two ways — through the real Marko 6 toolchain (`@marko/compiler` 5.42.5 +
`marko/translator`, exactly matching `marko@6.3.51`'s own dependency) and
through `@markox/translator`'s `compile()` — and compares both against
`expected.html` for **semantic** equality (`normalize-html.ts`'s
`htmlEquals`: both sides parsed with `parse5` and compared by decoded
tag/attribute/text/comment content, not by string spelling). `-- --strict` is
accepted for CLI symmetry with `oracle -- --strict` but does not fail on a
recorded, reasoned skip/divergence (`meta.json` in a fixture directory — see
`fixtures/README.md`'s "oracle:marko" section for the full contract) — that
classification is the settled state, not unfinished work like `oracle`'s own
`pending`/`skipped`. The run fails if the fixture glob is empty, a fixture is
missing one of its three files, or too few fixtures were processed (decision
55: a gate must assert it did work, not only that nothing failed). See the
script's own footer for the current pass/skip/bug count.

This is a separate script, not part of `bun run verify` or `moon run :verify`
— the Marko toolchain is a real install/memory cost and this task's own load
rule is one heavy process at a time. Run it in CI as its own job if
`.github/workflows/` grows a verify workflow; none exists yet in this repo, so
there is nothing to wire it into today.

Two Marko-toolchain facts worth knowing before touching
`packages/oracle/src/marko-compile-stock.ts`:

- `compileFile`'s `translator` option must be resolved and passed as the imported module object (`import * as translator from "marko/translator"`), not the string `"marko/translator"` — passing the string fails to resolve relative to the compiler's own internal base path rather than the caller's `node_modules`.
- `optimize: true` is required to get a plain server-HTML render: without it, `@marko/compiler` emits Marko's resume/hydration markers (an HTML comment plus an inline `<script>`) even under `output: "html"`. It does not fully suppress them — `<input>` and dynamic spread attributes still emit one regardless of `optimize` — so `normalize-html.ts`'s `stripMarkoResumeMarker` strips the trailing `<!--M_$…--><script>…</script>` pair before comparison: it is Marko hydration plumbing with no `@markox/translator` equivalent to compare against, not template content, and its id/script body is randomly generated per compile so it can never byte-match anyway.

## Vite plugin

`packages/mx-vite-plugin` (`@markox/vite-plugin`) is the primary integration
(spec section 7.1): an `enforce: "pre"` Vite transform that prints
`.solid.mx` to JSX source text with `print()` ahead of
`@solidjs/vite-plugin`. Both plugins are `enforce: "pre"`, so their relative
order is their order in the `plugins` array — `mx()` must come first.

`mx()`'s default `extensions` is `[".solid.mx", ".mx", ".marko"]`: `.mx` (the
official extension, decision 72) and its `.marko` alias both compile through
`@markox/translator`'s `compile()` instead of `print()`, to a plain
`(input) => string` module (no JSX, no Solid) — `suffixFor(ext)` picks `.ts`
for that path and `.tsx` for `.solid.mx`, so rolldown never runs a JSX
transform over code that has none. `.solid.mx` is otherwise byte-for-byte
unchanged by this: same suffix, same `print()` call, same source map, and it
keeps precedence over `.mx` regardless of `extensions` order (`.mx` is a
literal string suffix of `.solid.mx`, so the longest-first sort at
`index.ts`'s `matchExt`/`isMxModule` setup matters here the same way it did
for the old `.marko`/`.solid.marko` collision). The `.mx`/`.marko` path
returns `map: null` from `transform` — `compile()`'s map is presently an
identity placeholder (see `packages/translator`'s own doc comment: no AST is
printed on that path), so there is nothing real to hand Vite yet.

`compileMarko()` inside the plugin dynamically `import()`s
`@markox/translator` rather than importing it statically at module top level,
and this is load-bearing, not a style choice: `@markox/translator` has no
compiled entry (`main` is `src/index.ts`), and its `translate.ts` pulls in
`@marko/compiler`. A static import would load that dependency the instant
`vite.config.ts` imports this plugin — including for a `.solid.mx`-only
project like `examples/counter-app` that never touches `.mx`/`.marko` — and
previously broke `vite build` for such projects, because Vite's own config
loader (and, separately, Node's plain `import()`/`require()`) reads
TypeScript through Node's native strip-only mode, which used to reject a
`readonly` parameter property in `TranslateError`'s constructor (fixed to
plain fields, since it is public API a no-build-step consumer can hit
directly). A dynamic `import()`, not `require()`: `require()` on a bare
specifier whose `main` is TS source goes through Node's native loader with
zero transform under a Node-native `require` (e.g. inside a Vitest test),
hitting the same class of error one import further in; dynamic `import()`
goes through Vite's/Vitest's own transform pipeline, which strips TypeScript
fully.

Any consumer of this plugin needs `allowImportingTsExtensions` in its own
`tsconfig.json`, even one that only writes `.solid.mx`: resolving
`@markox/translator`'s types at all — even through the plugin's own dynamic
`import()`, cast away at the call site — means `tsc` walks that package's
`.ts` source, which needs the flag wherever it lands. `examples/counter-app`
and `examples/todomvc` both carry it for exactly this reason, not because
either project imports `.ts` paths itself.

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

## `@markox/core`: the Marko-node consumer

`packages/core` (`@markox/core`, decisions 70 to 72) is the half every MX host
shares: it consumes Marko's AST through `@marko/compiler`, applies the
structural lowerings (`<if>`/`<else>`, every `<for>` form, `<define>`,
`<const>`, statement tags, the field and inert-shape guards) and asks a
`Policy` for everything host-specific. `@markox/translator` is the first host;
SolidMX and Astro follow. `packages/core/README.md` documents the Policy
members one line each, the hooks and the front doors — read it before adding
either.

Four facts worth knowing before editing it:

- **It depends on `@marko/compiler` and nothing else.** `core.ts` used to parse
  an `import` line with `@markox/parser` — the *SolidMX parser* package — for a
  single `parse` call. It now asks `@marko/compiler/internal/babel`
  (`parse`/`parseExpression`/`traverse`/`types`, all present), which is also
  the instance Marko's own nodes belong to. Do not reintroduce a second Babel.
- **The emit layer here is the core's default string-emit model**, not a
  policy: `out +=` buffering, `blockFunction`, `VOID_TAGS`, `DYNAMIC_TAG`, the
  emitted module shape. A string host reuses it as is (which is what makes a
  second string host cheap); a JSX host (SolidMX, phase 4) replaces the emit
  layer instead. Pushing `VOID_TAGS` behind a policy member would cost every
  string host an indirection and buy the JSX host nothing.
- **Three stateful-tag hooks** (decision 70), real and unit-tested against a
  fake policy in `src/hooks.test.ts`, used by no host yet: `policy.emitSpecial`
  (the tag handler), `ctx.hoist(code)` (lift a statement to the enclosing
  function's head — the render function, or the nearest `blockFunction`), and
  `ctx.bindings.register(name, rewrite)` (rewrite identifier *references*, so a
  host whose state is a getter emits `count()` for `${count}`). Reference
  positions only, and shadowing is deliberately untracked.
- **`parseFragment` is spike 1's stopgap, with measured limits.** Marko's own
  nodes carry no numeric `start`/`end` at all (only `loc.{line,column}`); the
  Babel expression nodes nested inside them carry their offset at
  `loc.*.index`; **position objects are shared between nodes**, so the walk
  dedupes them or a second visit lands at `base + base` (measured: raw index 16
  with `baseOffset: 42` came out at 100 instead of 58); a thrown parse error's
  position is on the exception, not in the tree, and is shifted separately.
  `parseFragment` also passes a **parse-only translator stub** (empty
  `translate`), because `@marko/compiler` otherwise resolves its default
  `marko/translator` before parsing and fails — the `marko` package is not a
  dependency here. SolidMX's own bridge
  (`packages/mx-parser/src/mx/bridge.ts`) is untouched until phase 4.

## `@markox/translator`: the vanilla HTML host on `@markox/core`

`packages/translator` (`@markox/translator`, decisions 66, 68) compiles an
**ordinary Marko template** to a runtime-free `(input) => string` module. Not
a dialect: tag discovery through taglibs and `tags/` directories, Marko's own
HTML/SVG/MathML element registry, Marko's attribute-tag and component
conventions. The seam is `config.translator` — package-name discovery is a
dead end, since 5.42.5 scans only `@marko/runtime-*`.

The generic half now lives in `packages/core` (`@markox/core`) — see
"`@markox/core`: the Marko-node consumer" below. `packages/translator` keeps
`translate.ts` (the policy rows, `strictPolicy`), `bun.ts`, `types/`,
`example.ts`, the taglib and the fixtures; its `index.ts` is a thin wrapper
over the core's `compileSource`, and its own `emitProgram` is now a
`postEmit(code: string) => string` pass that appends the
`classValue`/`styleValue`/`escapeComment`/`renderDynamic` helpers a template
actually calls. `escape` moved to the core and is re-exported here, so every
compiled template's `import { escape } from "@markox/translator"` is
unchanged. The `./core` export is **gone** (breaking): importers take
`@markox/core` directly.

Policy table (decision 65): the target renders what Marko's server render
emits, minus resume markers. **Inert** (accepted, no output, each verified
byte-identical against Marko): `<effect>`, `<lifecycle>`, `<script>`, `<id>`,
`<log>`, `<debug>`, `client` blocks (client-only), and `by=` on `<for>`. A
`server` block is **not** inert — this is the server render, so it runs and
hoists like `static`, and its bindings are readable from the template
(verified: `server const S = 41 + 1` then `${S}` renders `42`). `<return>` is
an error: it hands a value to a parent template, and a module compiled to
`(input) => string` has no parent. **Evaluate initial
value**: `<let>`, `<const>`, `:=`. **Error** — only what the target genuinely
cannot: `<await>` (Marko itself refuses to render one to a string) and
`<try>` with a `<@placeholder>` (needs a second pass). A plain `<try>` with
`<@catch>` lowers to `try`/`catch`.

**Inert is a shape, not a licence to drop.** An inert row declares the body
and attributes its own Marko tag definition allows, and anything else is an
error naming the tag and what was found — otherwise
`<effect><div>x</div></effect>` compiles clean with the `<div>` deleted, which
is the S8 silent-drop class reopened. The declarations are per tag because
Marko is: `<effect foo="bar"/>` and `<log=1 foo="bar"/>` are refused there,
while `<lifecycle foo="bar"/>` compiles (a lifecycle tag's attributes are its
configuration), and `<script>` is the one inert tag taking a body (raw text).

Some constructs need no row at all, because Marko's own parser rejects them
before a translator runs — do not add code for these, and do not read their
absence as tolerance: `key=` on an element, and `$!{…}` in an attribute value.

`class:foo`/`style:foo` are a separate category: **not Marko syntax**, rather
than something this target cannot express. Marko has no such modifier and says
so (*"`class:active` is not a valid attribute, did you mean
`class={ active: condition }`?"*), so the translator errors with Marko's own
fix-it. There is no behaviour to reproduce and no fixture to write, since no
`.marko` file using them compiles at all.

A **render-scope** binding named `input` (`<let/input=…>`, `<const/input=…>`)
is rejected: it would shadow the emitted `function (input: Input)` parameter
and make the template's own input unreachable, and Marko refuses it as a
duplicate declaration. A **tag param** (`<for|input|>`, `<define/R|input|>`) is
*accepted*, because it opens a nested scope where an ordinary JS shadow is
correct — Marko renders those. Rejecting them would be an implementation limit
stated as a rule, which decision 65 forbids. Note the codegen consequence: a
`<for>`'s iterable is bound to a temporary before the loop opens, or a param
shadowing the name used in the iterable (`<for|input| of=input.items>`) hits
the temporal dead zone and throws at render time.

Two behaviours worth knowing before editing the policy, both verified rather
than assumed:

- **Marko hoists `value` first on `<input>`**, so
  `<input type="text" value=x>` emits `<input value=… type=text>`. A browser
  applies `type` before `value`, and some types reinterpret a later `value`.
  `orderAttrs` in the policy reproduces it; `htmlEquals` compares attribute
  order, so getting this wrong fails the oracle.
- **`class`/`style` take structured values**: `class={a: true, b: false}` →
  `class="a"`, `class=["x", {y: true}]` → `class="x y"`,
  `style={color: "red", top: 0}` → `style="color:red;top:0"`. These lower to
  emitted `classValue`/`styleValue` helpers, inlined only when called, so a
  template using none of them still compiles to `escape` and concatenation
  alone.

`bun run oracle:marko` prints one table, for
`packages/translator/fixtures-marko` — see the "oracle:marko" section above
for the current fixture count and pass/skip/bug totals. Fixture
`expected.html` files are generated from real Marko, never hand-written.

### The `strict` policy

Decision 68's policy fold: the retired `.mx` dialect rejected reactive
constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks,
`<id>`) by name, since standalone MX had no reactive target at all. The
default `policy` above instead renders what Marko's own server render would
emit for those (inert, or `<let>`'s initial value) — decision 65's table.
`strictPolicy` (`translate.ts`) keeps `.mx`'s stance as an *opt-in*: the same
six constructs become errors naming the construct, for an author who wants
"this needs a reactive runtime" to be a compile error. `compile`/`compileFile`/
`build` take `{ strict: true }` to select it. The `input`-shadowing check
(`checkBinding`) is **not** `strict`-only — it was already the default in
both the old `.mx` policy and this one, since a `<let>`/`<const>` binding
named `input` silently breaking the template's own input is a bug either way,
not a stricter preference. Dropped rather than folded in (decision 65: these
were conventions of the old `.mx` walk, not target capabilities, so they do
not survive as a policy toggle): the explicit-import requirement, the
`export interface Input` requirement (Marko allows arbitrary TS regardless),
`<fragment>`, and lowercase-by-scope tag resolution.

`<html-comment>` lowers placeholders as Marko does, through an emitted
`escapeComment` helper that escapes **only `>`** — `<`, `&` and quotes pass
through raw, matching Marko's own `_escape_comment`. Filtering placeholders
out (an earlier bug) turned `<html-comment>build ${input.sha}</html-comment>`
into `<!--build -->`.

## Bun loader

`packages/translator/src/bun.ts` (`@markox/translator/bun`) is the Bun-side
`.marko` integration, decision 58 roadmap item 2, half A (moved here from the
retired `@markox/html/bun` by decision 68). It exports a `BunPlugin` that
registers `build.onLoad({ filter: /\.marko$/ }, ...)`: on each `.marko` file
it reads the source, runs it through `compile()`, and returns
`{ contents: code, loader: "ts" }` — `compile()`'s output is plain TypeScript
(an `import`, an optional `export interface Input`, a default-exported
function, no JSX), so Bun's own TS stripper handles it directly with no
second transform.

The plugin object self-registers at import time (`Bun.plugin(markoPlugin)`
runs at module scope, in addition to the `export default`): `bunfig.toml`'s
`preload = ["@markox/translator/bun"]` runs a preloaded module purely for its
side effects — it does **not** call `Bun.plugin` on a default export
automatically — so without the self-registration call, `.mx`/`.marko`
imports silently fall through to Bun's default loader and resolve to the
file's path string, not a compiled function. `Bun.plugin` is idempotent for
an already-registered plugin object, so `import markoPlugin from
"@markox/translator/bun"; Bun.plugin(markoPlugin)` (the programmatic form)
still works without double-registering.

`examples/mx-site` uses this loader: `bunfig.toml` preloads it, `.mx` pages
import each other directly (`import Layout from "./layout.mx"`), one partial
(`partials/callout.marko`) is kept as the `.marko` alias to exercise it end
to end, and `src/server.ts`/`src/build.ts` import pages directly with no
prebuild step.
The compiled-output equality check decision 58 calls for ("cannot paper over
an emit bug") lives in the e2e suite's own content assertions
(`e2e/routes.spec.ts`), run against both the dev server and the static
build — there is no separate golden-file diff, since the rendered HTML
itself is the golden.

`packages/translator/src/bun.test.ts` is a `bun:test` file (not vitest — it
exercises `Bun.plugin` and Bun's own dynamic `import()`, both Bun-runtime
only), run via `bun run test:bun` in that package. `packages/translator`'s
own `vitest.config.ts` excludes it from the vitest project so the root
`bun run test` does not try to load `bun:test` under Node/Vite.

## `.mx`/`.marko` import typing

`packages/translator/types/marko.d.ts` declares `declare module "*.mx"` and
`declare module "*.marko"`, both typing the import as `(input: any) =>
string`. `any`, not each file's real `Input` interface: per-file typing
needs a virtual-file projection of the compiled module (mirroring
`@markox/typescript-plugin`'s role for `.solid.mx`), which is the phase-3
language server's job, not something an ambient wildcard declaration can
derive. A consumer references it by adding the file to its own
`tsconfig.json` `include` (see `examples/mx-site` and `examples/mx-vite`);
there is no package-level `types` wiring that pulls it in automatically,
since a `.solid.mx`-only project (the Solid examples) has no reason to load
it.

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
static build both rendering MX (`.mx`) templates via
`@markox/translator/bun` (the Bun loader — see its own section above), no
Solid, no client runtime, no prebuild step. `src/server.ts` and
`src/build.ts` `import renderX from "./pages/x.mx"` directly, exactly like
any other module; `bunfig.toml` preloads the loader.

`packages/translator/tsconfig.json` maps `@markox/parser` to
`../mx-parser/src/public.d.ts` in its `paths`, for typechecking against the
parser's public types without requiring `dist/` to be built first. Bun's
`bun run` also honours `tsconfig.json` `paths` at runtime, and does so per
imported file's own directory, not just the entry point's — so a plain `bun
run` of any script that imports `@markox/translator` (which imports
`@markox/parser`) fails with `Export named 'X' not found in module
".../public.d.ts"`, because Bun resolves the bare `@markox/parser` specifier
against `packages/translator/tsconfig.json`'s `paths` regardless of where the
importing file lives. Work around it with `bun run
--tsconfig-override=<path to a tsconfig with no such paths>`; `examples/mx-site`'s
`dev` and `build` scripts do this against the root `tsconfig.base.json`. This
is a property of `translator`'s tsconfig, not a bug in `@markox/translator`
itself or in Bun's resolver generally — vitest is unaffected because it does
not resolve bare specifiers through `tsconfig.json` `paths` the same way.

`examples/mx-vite` is a minimal static-site build exercising
`@markox/vite-plugin`'s `.mx` handling (not `.solid.mx`): two `.mx` pages
under `src/pages/`, a tiny `src/build.ts` that imports both and writes
`dist/*.html`, and a `vite.config.ts` whose `build.ssr` is that script rather
than a browser entry — `vite build` bundles it through the plugin's
`.mx`/`.marko` transform, then `bun run dist-ssr/build.js` actually runs it
and writes the
HTML. `vite.config.ts`'s `ssr.external: ["@markox/translator"]` keeps that
package's own `import { escape } from "@markox/translator"` (present in
every compiled `.mx` page) out of the rolldown bundle — left un-external,
rolldown would try to bundle `@markox/translator`'s raw TS source itself,
pulling in `@marko/compiler`'s transitive syntax the same way the plugin's
own dynamic `import()` has to route around (see the Vite plugin section
above).
