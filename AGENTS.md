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
- `examples/astro-static` — e2e only
- `examples/counter-app` — e2e only
- `examples/mx-site` — e2e only
- `examples/mx-vite` — e2e only
- `examples/todomvc` — e2e only
- `packages/zed-extension` — grammar and Rust extension (registers
  `@mxlang/language-server`), both build-verified in CI
  (`zed-compile-check`, `zed-extension-compile-check`)

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
`@mxlang/html` and `packages/mx-html` stay deleted, and those conventions do
not come back. Decision 72 re-establishes `.mx` as MX's own **identity**,
distinct from that dialect: MX is its own language with Marko as its origin,
and MX 1.0 is a strict subset of Marko syntax — every MX 1.0 file is a valid
Marko file with the same meaning for the structural core. `.mx` is the
official extension; `.marko` is accepted everywhere with identical
treatment, so porting a Marko component to MX is a rename or nothing.
`.solid.mx` is unaffected — a different file kind (TSX with MX regions), not
covered by this alias.

- `parse(source, filename)` in `@mxlang/parser` — a `.solid.mx` file: a
  TypeScript module in which `<` in expression position opens an MX element,
  lowered to Solid 2 JSX. This is the parser package's only mode; there is no
  `mxMode` option. SolidMX is a separate host from the vanilla one below, and
  is not affected by either the `.mx`/`.marko` alias or decision 68's dialect
  retirement.
- `compile(source, filename)` in `@mxlang/translator` — a whole-file MX
  template (`.mx` or its `.marko` alias, both stock Marko syntax with no
  dialect layered on top). `@marko/compiler` parses, validates and supplies
  the tag registry; the package supplies only a translator
  (`packages/translator/src/translate.ts`) and its own taglib
  (`packages/translator/taglib/marko.json`). `@mxlang/parser` is not on this
  path at all. The Bun loader (`@mxlang/translator/bun`) and
  `@mxlang/vite-plugin`'s `mx()` both accept `.mx` and `.marko` identically,
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

`@mxlang/translator`'s translator (`translate.ts`'s dispatch) decides
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

`@mxlang/parser`'s `main` is `dist/index.js`, so a freshly created worktree
needs `bun install` **and** `bun run build` before any dependent package's
tests will run — without `dist/` every consumer fails with "Failed to resolve
entry for package @mxlang/parser" (the oracle fails the same way). `bun run
verify` builds before it tests, so this only bites when running one package's
tests directly.

`packages/tree-sitter-solidmx/vendor/` is gitignored, so a fresh worktree has
none — `scripts/test.sh` now runs `scripts/vendor.sh` itself when
`vendor/tree-sitter-typescript` is missing (printing one line saying so), so
`bun run verify` and `bun run test:grammar` pass from a clone with no manual
setup step.

Per-package vitest runs need the root config: `bunx vitest run --root ../..
--project @mxlang/<name>`. A bare `bunx vitest run` inside a package directory
fails with "No projects were found", because `projects: ["packages/*"]` is
resolved relative to the root.

`packages/translator` (`@mxlang/translator`) holds the string target:

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

`packages/zed-extension` (`mxlang`) ships three languages for Zed: `MX`
(`.mx`, restored per decision 72), `AstroMX` (`.amx`, decisions 76c/78) and
`SolidMX` (`.solid.mx`). `AstroMX` rides the same `marko` grammar and the
same queries as `MX` — an `.amx` file's template half *is* MX — so it adds no
`[grammars.*]` entry; see the `.amx` subsection under `@mxlang/astro` above,
and `packages/zed-extension/README.md` for its one limitation (Marko's
grammar has no `---` frontmatter notion, so the fence highlights as markup).

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
alongside `mxlang` for the SolidMX injection to highlight (see below). `MX`
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

**Rust `lib.rs` registers the MX language server** (decision 77, task
`zed-ls-registration`): `Cargo.toml` + `src/lib.rs` implement
`zed::Extension::language_server_command`, and `extension.toml` carries
`[language_servers.mxlang]` (`languages = ["MX"]` only — `SolidMX`/`AstroMX`
are not listed since `@mxlang/language-server` does not compile those file
kinds yet). Minimal by design: no settings, no downloads — command
resolution checks a local worktree install (via `Worktree::read_text_file`,
the sandbox-safe check: Zed's wasm sandbox preopens only the extension's own
working directory, so a plain `std::fs`/`Path` check on a worktree path
always reports "not found" and cannot be used; there is also no walk-up past
the worktree root, since `Worktree`'s API has no such operation), else a
global install via `Worktree::which`, else `bunx @mxlang/language-server
--stdio`, else `npx`. Built to
`wasm32-wasip1` by `scripts/zed-extension-compile-check.sh` (a clean-clone
gate, same shape as `tree-sitter-solidmx`'s own `zed-compile-check.sh`),
wired into `ci.yml` as its own job (`rustup target add wasm32-wasip1` on the
runner first — this is the one place in this repo Rust is required; the
target is a toolchain install, not a repo dependency). See
`packages/zed-extension/README.md` "Toolchain prerequisite" and "Language
server", and `UPSTREAM.md` for the pinned `marko-js/zed` commit the `lib.rs`
shape was read from.

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

`packages/oracle` (`@mxlang/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, across **both Solid 2 backends and both generate variants** — four rows per fixture. `bun run oracle` runs it standalone and prints a fixture/backend/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

Backends (`compile.ts`'s `backend: "babel" | "native"`):

- `babel` — `@solidjs/babel-plugin`, the `babel-preset-solid` successor, over a Babel JSX AST via `parserOverride`.
- `native` — `@solidjs/compiler`, Solid's Oxc compiler and `@solidjs/vite-plugin`'s default. Its only entry point is `transform(code, options)` over **source text**, so MX reaches it by printing its lowered AST back to JSX text first. Both backends must pass: they are separate codegen implementations.

Variant names are unchanged from Solid 1 (`generate: "dom" | "ssr"` plus `hydratable`) — both 2.0 packages document the same spelling.

Two native-compiler gotchas, worked around in `compile.ts`:

- The documented `syntax` option (README and `types.d.ts`) is **rejected at runtime** by rc.7. Frontend routing is by filename.
- The compiler picks its parser dialect from the **filename extension** and rejects `.solid.mx`. The oracle appends `.tsx` to MX filenames for that backend, like `@mxlang/vite-plugin`'s virtual id.

`@mxlang/parser` exports two printer entry points, both sharing one set of `@babel/generator` options so they cannot drift: `print(source, filename)` for the ordinary case, and `printAst(ast, filename)` for callers that must run their own pass over the AST first. The oracle needs the second one — `.solid.mx` fixtures use TypeScript syntax, `@babel/preset-typescript` has to erase it before printing, and `print` would re-parse the source and skip that erasure, handing `interface Todo { ... }` to a JSX-only frontend.

A twin must not introduce whitespace MX drops. MX follows Marko's rules — a whitespace-only run containing a newline is dropped — so `text<p>…` goes on one line in the twin wherever the MX source separates them only by indentation. See `fixtures/README.md`.

`@mxlang/parser` is wired into the harness (`packages/oracle` depends on it and `report.ts` passes its `parse` as `mxParser`), so fixtures compile for real. Statuses: `pass`, `fail` and `divergent` mean the parser ran; `skipped` means no parser was available (now a real failure, not "not implemented"); `pending` means the fixture carries a `PENDING` marker naming constructs the parser cannot lower yet. Neither `skipped` nor `pending` is a pass, and `--strict` fails the run on either — see `fixtures/README.md` for the `PENDING` contract.

Current state: `counter`, `todos`, `attrs` and `lists` all pass on both backends and both variants (16 rows). `bun run oracle` and `bun run oracle -- --strict` are both expected to exit 0 — `--strict` green is the standing bar, not an aspiration.

`packages/oracle/src/compile.ts` runs `@babel/preset-typescript` after parsing `.solid.mx` too, not only `.tsx`: the vendored MX parser accepts TS syntax (interfaces, type annotations, generics) but `mxParser`'s `parserOverride` only replaces the *parse* step, not the erasure pass, so TS type nodes are still in the AST afterward and need the same stripping a `.tsx` file gets — or they leak into the compiled output and break byte parity against a twin that went through the ordinary TS pipeline.

Golden snapshots (`fixtures/<name>/__golden__/twin.<backend>.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a Solid 2 pin bump changing generated code. Regenerate them deliberately with `bun run oracle -- --update` and call it out in the PR — never let a pin bump change them as a silent side effect.

`packages/mx-parser/src/mx/perf.test.ts`'s 500ms wall-clock budget only fails the test when `MX_PERF_STRICT` is set; otherwise it just `console.warn`s past the budget, since a plain `bun run verify` under machine contention (several agents/verifiers at once) can blow well past 500ms with no actual parser regression.

### `oracle:marko`: Marko parity for the stock `.marko` fixture set

Decision 51: the parity target for Marko-syntax constructs is Marko itself,
not Solid. Decision 68 retired `.mx`/`@mxlang/html`, so there is one dialect
and one table: `bun run oracle:marko` (`packages/oracle/src/report-marko.ts`,
delegating to `report-marko-stock.ts`) renders every fixture under
`packages/translator/fixtures-marko/<name>/{input.marko,input.json,expected.html}`
two ways — through the real Marko 6 toolchain (`@marko/compiler` 5.42.5 +
`marko/translator`, exactly matching `marko@6.3.51`'s own dependency) and
through `@mxlang/translator`'s `compile()` — and compares both against
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
- `optimize: true` is required to get a plain server-HTML render: without it, `@marko/compiler` emits Marko's resume/hydration markers (an HTML comment plus an inline `<script>`) even under `output: "html"`. It does not fully suppress them — `<input>` and dynamic spread attributes still emit one regardless of `optimize` — so `normalize-html.ts`'s `stripMarkoResumeMarker` strips the trailing `<!--M_$…--><script>…</script>` pair before comparison: it is Marko hydration plumbing with no `@mxlang/translator` equivalent to compare against, not template content, and its id/script body is randomly generated per compile so it can never byte-match anyway.

## Vite plugin

`packages/mx-vite-plugin` (`@mxlang/vite-plugin`) is the primary integration
(spec section 7.1): an `enforce: "pre"` Vite transform that prints
`.solid.mx` to JSX source text with `print()` ahead of
`@solidjs/vite-plugin`. Both plugins are `enforce: "pre"`, so their relative
order is their order in the `plugins` array — `mx()` must come first.

`mx()`'s default `extensions` is `[".solid.mx", ".mx", ".marko"]`: `.mx` (the
official extension, decision 72) and its `.marko` alias both compile through
`@mxlang/translator`'s `compile()` instead of `print()`, to a plain
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
`@mxlang/translator` rather than importing it statically at module top level,
and this is load-bearing, not a style choice: `@mxlang/translator` has no
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
`@mxlang/translator`'s types at all — even through the plugin's own dynamic
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

`@mxlang/parser`'s `main` is `dist/index.js`, not `src/index.ts`. Vite's config
loader externalizes bare imports, so a consumer that pulls the parser's TS
source makes Node load the vendored Babel tree, whose `const enum`s the
strip-only TypeScript loader rejects. `types` still points at
`src/public.d.ts`, so typechecking never needs a build; `bun run verify`
builds before it tests.

## `@mxlang/core`: the Marko-node consumer

`packages/core` (`@mxlang/core`, decisions 70 to 72) is the half every MX host
shares: it consumes Marko's AST through `@marko/compiler`, applies the
structural lowerings (`<if>`/`<else>`, every `<for>` form, `<define>`,
`<const>`, statement tags, the field and inert-shape guards) and asks a
`Policy` for everything host-specific. `@mxlang/translator` is the first host;
SolidMX and Astro follow. `packages/core/README.md` documents the Policy
members one line each, the hooks and the front doors — read it before adding
either.

Four facts worth knowing before editing it:

- **It depends on `@marko/compiler` and nothing else.** `core.ts` used to parse
  an `import` line with `@mxlang/parser` — the *SolidMX parser* package — for a
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

## `@mxlang/translator`: the vanilla HTML host on `@mxlang/core`

`packages/translator` (`@mxlang/translator`, decisions 66, 68) compiles an
**ordinary Marko template** to a runtime-free `(input) => string` module. Not
a dialect: tag discovery through taglibs and `tags/` directories, Marko's own
HTML/SVG/MathML element registry, Marko's attribute-tag and component
conventions. The seam is `config.translator` — package-name discovery is a
dead end, since 5.42.5 scans only `@marko/runtime-*`.

The generic half now lives in `packages/core` (`@mxlang/core`) — see
"`@mxlang/core`: the Marko-node consumer" below. `packages/translator` keeps
`translate.ts` (the policy rows, `strictPolicy`), `bun.ts`, `types/`,
`example.ts`, the taglib and the fixtures; its `index.ts` is a thin wrapper
over the core's `compileSource`, and its own `emitProgram` is now a
`postEmit(code: string) => string` pass that appends the
`classValue`/`styleValue`/`escapeComment`/`renderDynamic` helpers a template
actually calls. `escape` moved to the core and is re-exported here, so every
compiled template's `import { escape } from "@mxlang/translator"` is
unchanged. The `./core` export is **gone** (breaking): importers take
`@mxlang/core` directly.

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

## `@mxlang/astro`: the Astro host

`packages/astro` (`@mxlang/astro`, decisions 70 to 72) renders `.mx`
components inside an Astro project as **static markup**: no islands, no
hydration, no client JS from this renderer. Two files and no third —
`src/index.ts` is the integration, `src/server.ts` the renderer's server
entrypoint. There is no compile step of its own: the integration adds
`@mxlang/vite-plugin` through `updateConfig({ vite: { plugins: [...] } })`,
since an Astro project is a Vite project and that plugin already turns a
`.mx` file into a plain module.

Four facts worth knowing before editing it:

- **`check` tests a brand, and the brand is emitted by the *translator*.**
  Astro's renderer contract hands `check(Component, props, slots)` the
  component as an opaque value with no reserved brand channel, and Astro's own
  docs suggest sniffing `Component.name` — which a minifier may rewrite and
  any function could collide with. Instead `@mxlang/translator`'s `postEmit`
  (`brandRender` in `translate.ts`) names the core's anonymous default export
  `render`, marks it, and exports it, so every compiled MX module carries
  `Symbol.for("mx.component")`. `Symbol.for`, through the global registry, not
  a `unique symbol`: the property is written by a compiled module and read by
  a different package, possibly from a different copy of the translator on
  disk, so the two sides cannot agree by import identity. It is written with
  `Object.defineProperty`, not `render[Symbol.for(…)] = true` — the emitted
  module is TypeScript a consumer typechecks, and the assignment form is
  `TS7053` under `strict`, which would make every compiled template a type
  error in the user's own build.
- **Slots are strings; MX's children are thunks.** Astro hands slots in as
  `Record<string, string>` of already-rendered HTML, while MX's compiled
  modules take children as a `content: () => string` prop and each `<@name>`
  attribute tag as `name: () => string`. `renderToStaticMarkup` wraps each
  slot string in a thunk (`default` → `content`, every other key → the
  attribute tag of the same name). Two limits follow, both Astro's contract
  rather than MX's: an attribute tag declaring **params** (`<@footer|year|>`)
  can never receive them from Astro, and is documented rather than detected
  (the renderer sees a compiled function, not the template); and slot HTML is
  inserted verbatim, so a template must use `$!{input.content()}`, never
  `${...}`, or the markup Astro rendered comes out escaped.
- **The host compiles under `strictPolicy`**, so `<let>`, `<effect>`,
  `<lifecycle>`, `<script>`, `client` blocks and `<id>` are compile errors
  naming the construct (decision 71: stateful tags mean whatever the host
  says, and this host has no reactive target at all). That required the one
  change to `@mxlang/vite-plugin` this package needed: a `strict?: boolean`
  option on `MxPluginOptions`, passed straight through to `compile()`. It is a
  passthrough, not a policy of the plugin's own; `.solid.mx` never goes
  through the translator and is unaffected.
- **No `clientEntrypoint`, and the host raises the `client:*` error itself.**
  `AstroRenderer` declares the field optional, so a hydration-free renderer is
  a first-class shape. The research note (and this file, before it was
  measured) claimed `client:*` on such a component raises Astro's own
  `NoClientEntrypoint`. **It does not, in astro@7.3.2.** That error is defined
  in `dist/core/errors/errors-data.js` and thrown from nowhere — grepping the
  whole installed package finds only the definition and its `.d.ts`. The render
  path is a bare `if (renderer.clientEntrypoint)`
  (`dist/runtime/server/hydration.js:98`) that skips `renderer-url`,
  `component-export` and `props` when absent, with no else branch. Left alone
  the build would succeed and emit an `<astro-island client="load">` whose
  loader falls back to `Promise.resolve({default:()=>()=>{}})` — an island that
  silently does nothing, on a host whose claim is shipping no client JS.
  Decision 70's intent is that the directive is an error, so
  `renderToStaticMarkup` throws on `metadata.hydrate` (Astro's own fourth
  argument; `AstroComponentMetadata.hydrate` is
  `'load'|'idle'|'visible'|'media'|'only'`, and `displayName` names the
  component). `examples/astro-static/e2e/build-errors.spec.ts` asserts the
  failing build.

### `.amx`: AstroMX templates (decisions 76c, 78)

An `.amx` file is an **Astro component whose template is MX** — a different
file kind from `.mx`, not a variant of it. A `.mx` component compiles to a
runtime-free `(input) => string` and is called *through* this package's
renderer; an `.amx` component **becomes** an Astro component: the `---` fence
passes through byte for byte with Astro's own semantics (`Astro.props`,
imports, `getStaticPaths`), the MX template after it is lowered to Astro
template syntax, and the whole file goes to Astro's compiler. Components,
layouts and pages, all from one extension (`addPageExtension(".amx")`).

Four facts worth knowing before editing `src/astro-template.ts` or
`src/vite-templates.ts`:

- **The extension is single-dot because of Astro's router, not taste.**
  `.astro.mx` was the first spelling and works for components, but Astro's
  route collection keys on `path.extname(basename)`, which returns only the
  **last** extension segment (`create-manifest.js`; `parse-route.js` does the
  same through `@astrojs/internal-helpers`' `fileExtension`, which is
  `path.split(".").pop()`). Measured against astro@7.3.2: a `page.astro.mx`
  under `src/pages` is `continue`d as an unsupported file type, and once `.mx`
  is also registered it is routed to `/page.astro/` — a literal `.astro` in
  the URL. Note `dist/core/util.js`'s `endsWithPageExt` *does* use `endsWith`,
  so `isPage()` accepts what route collection rejects: two code paths in one
  version disagree. `.amx` sidesteps all of it.
- **This is an emitter, not a `Policy`.** `@mxlang/core`'s emit layer is the
  string-emit model — `emitLiteral` pushes `out += "..."`, `emitFor` pushes
  `for (const x of xs) {`, and `emitChildren` claims `<if>` before any policy
  dispatch — all statement-shaped JS, while Astro's template syntax is
  expression-shaped (`{c ? (…) : (…)}`, `{xs.map(…)}`). No arrangement of
  policy members produces it. `packages/core/README.md` states the rule: a JSX
  host replaces the emit layer instead. So `.amx` uses the core's *other*
  front door, `parseFragment`, whose base-offset shifting is exactly what a
  template sitting after a fence needs, and supplies its own emit layer. The
  node walk and the emit callbacks are kept separate so SolidMX's phase-4 JSX
  host can lift the walk rather than write a third one.
- **The Vite mechanism is forced.** Astro's `astro:build` `transform` filters
  `include: [/\.astro$/, /\.astro\?/]` **and** re-checks
  `if (!parsedId.filename.endsWith(".astro")) return;`, so an `enforce: "pre"`
  transform on the real `.amx` id can never reach Astro's compiler. The module
  id itself must end in `.astro`: `resolveId` appends that suffix to whatever
  Vite's own resolver returns, `load` returns the lowered source. Same shape
  `@mxlang/vite-plugin` already uses for `.solid.mx`.
- **An attribute method is a `FunctionExpression` value, not `attr.arguments`.**
  `<button onClick() { … }>` arrives with `arguments` falsy and the method body
  as the attribute's *value* (measured against `@marko/compiler` 5.42.5).
  Testing only `attr.arguments` — the core's own check — let it fall through to
  the source-slicing path and fail with a parser-internal message instead of
  the unsupported-construct error. Both shapes are tested.

The lowering table and the full error list live in
`packages/astro/README.md` "AstroMX templates (`.amx`)". Nothing silently
degrades: every construct this target cannot express is a build error naming
the construct, the reason and the `.amx` line.

`packages/astro/types/mx.d.ts` declares `*.mx`/`*.marko` as
`(input: any) => string`, referenced by a consumer from its own `env.d.ts`
(`/// <reference types="@mxlang/astro/types" />`). `any` for the same reason
`@mxlang/translator`'s own `types/marko.d.ts` does it: per-file `Input` typing
needs a virtual-file projection inside tsserver, which is the `astro-ts-plugin`
task. `@astrojs/ts-plugin` is not reusable for it — it adds `.astro` imports
*within* `.ts` files, the opposite direction.

## `@mxlang/language-server`: diagnostics-only LSP server (decision 71/72)

`packages/language-server` (`@mxlang/language-server`) exists to close one
gap decisions 71/72 name explicitly: "a host is not done without its editor
diagnostics." Marko's own language server (`marko-js/language-server`)
compiles every `.marko`/`.mx` file with a **hardcoded** compiler config that
carries no host policy (`Project.getCompiler(dir).compileSync(text,
filename, compilerConfig)` in its `validate.ts`, with no `translator` key),
so a construct a host's `strict` policy rejects — `<let>`, `<effect>`,
`<lifecycle>`, `<script>`, `:=` — is valid Marko syntax and Marko's server
reports nothing for it. `tsserver` cannot fill the gap either: it never opens
`.marko`/`.mx` files at all, only `.ts`/`.tsx` files that *import* one (that
is what `@marko/ts-plugin` and `@mxlang/typescript-plugin` type-check). Full
research: `notes/research/host-diagnostics.md`.

**Scope: diagnostics only.** `textDocumentSync` is the one capability
advertised. No completion, hover, go-to-definition, or formatting — adding
any of those would mean re-implementing Marko's own language server, which
this package runs *alongside*, not in place of. Both VS Code and Zed support
multiple language servers registered against one language id (ESLint+TS,
Tailwind+CSS are the everyday examples); this is a supported pattern, not a
workaround.

**Mechanism.** `src/diagnose.ts`'s `diagnoseDocument(text, uri, hostPolicy,
onUnexpectedError?)` runs `@mxlang/core`'s `compileSource` under the resolved
policy; a thrown `TranslateError` (which carries 1-based `line` and 0-based
`column`, `@mxlang/core`'s `fail()`/`TranslateError` shape) becomes one LSP
`Diagnostic` (`severity: Error`, `source: "mxlang"`, message verbatim); a
successful compile returns `[]`, which the caller publishes to clear any
stale diagnostics; any other exception is swallowed and reported through the
callback rather than crashing the server or publishing something wrong — both
paths are unit-tested directly against `diagnoseDocument`, no server needed.
`src/server.ts` wires this into a `vscode-languageserver`
`TextDocuments`/`Connection`, debouncing 150ms per document URI (a
superseded run's timer is cleared, never raced) on `didOpen`/`didChange`/
`didSave`, and clears diagnostics on `didClose`.

**Policy resolution** (`src/resolve-policy.ts`) answers the question an
editor's `didOpen` cannot: which host, and whether `strict`, applies to this
file. Three branches, in order, walking upward from the file for the nearest
`package.json`: (1) a `"mxlang": { "host": ..., "strict"?: ... }` field, the
authoritative source, which doubles as the routing config decision 71's
"mixed projects" case already needs for the Vite plugin/Bun loader; (2)
failing that, if the `package.json` depends on **exactly one** `@mxlang/*`
host package (`@mxlang/translator`, `@mxlang/astro`), that host at its
default policy; (3) otherwise, the translator's default (non-strict) policy.
`@mxlang/astro` always compiles under `strictPolicy` (decision 71: it ships
no stateful tags) — `resolvePolicyObject` in `diagnose.ts` special-cases
`host: "astro"` to `strictPolicy` regardless of the field's own `strict`
value, since that host has no other mode. `host: "solid"` is a documented
placeholder: SolidMX is paused (decision 58) and exports no `@mxlang/core`
`Policy` object yet, so it falls back to the translator's policy rather than
throwing, keeping the rest of a mixed workspace diagnosed.

**Zed finding** (brief item 4): there is **no zero-Rust path** to register a
second `[language_servers.*]` entry in Zed's `extension.toml`. Reading
`marko-js/zed`'s own `extension.toml` and `src/lib.rs` (via `gh api
repos/marko-js/zed/contents/...`, no local checkout) confirms
`[language_servers.marko]` binds `languages = ["Marko"]` to that extension's
own `zed::Extension::language_server_command` implementation — a
`Cargo.toml`-backed Rust extension is what makes the entry work, not the TOML
table alone. `packages/zed-extension` is grammar-only today (no
`Cargo.toml`, see "No Rust" in the Zed extension section above) *because* it
registers no language server; adding this server's registration is therefore
new scope (a Rust crate) for that package, tracked as follow-up rather than
done in this task (time budget). `extension.toml` gained a comment
documenting this finding at `[grammars.marko]`. Both VS Code
(`LanguageClient` targeting `language: "marko"`, a second registration
alongside Marko's own) and Zed (`[language_servers.<key>]`, once the Rust
scaffold exists) support the second-server pattern once wired; see the
package's own `README.md` "Editors" for the concrete snippets, including the
generic-LSP-client `settings.json` shape for VS Code (which ships no
dedicated extension from this task, per brief scope).

*(Update, task `zed-ls-registration`, decision 77: the Rust scaffold this
paragraph names as follow-up now exists — see "Zed extension" above. VS
Code still ships no dedicated extension.)*

**Tests**: `src/diagnose.test.ts` (direct, no server: `<let>` under strict,
a valid file, `<let>`'s initial value under the non-strict policy, the
unexpected-exception path), `src/resolve-policy.test.ts` (all three
resolution branches against fixture directories under `src/fixtures/`), and
`src/server.test.ts` (the one stdio end-to-end test the brief asks for:
spawns the real built `dist/bin.js` with `bun run ... --stdio`, exchanges
`initialize`/`didOpen` via `vscode-jsonrpc`'s `createMessageConnection`, and
asserts the resulting `publishDiagnostics` notification; the child process is
killed in `afterEach`, honoring the load rule's "kill what you start").
Requires `bun run build` to have produced `dist/bin.js` first — the same
fresh-worktree caveat as `@mxlang/parser`'s `dist/index.js` (see "Running
tests in a fresh worktree" above): `bun run verify` builds before it tests,
so this only bites a standalone `vitest run` of this package.

## Bun loader

`packages/translator/src/bun.ts` (`@mxlang/translator/bun`) is the Bun-side
`.marko` integration, decision 58 roadmap item 2, half A (moved here from the
retired `@mxlang/html/bun` by decision 68). It exports a `BunPlugin` that
registers `build.onLoad({ filter: /\.marko$/ }, ...)`: on each `.marko` file
it reads the source, runs it through `compile()`, and returns
`{ contents: code, loader: "ts" }` — `compile()`'s output is plain TypeScript
(an `import`, an optional `export interface Input`, a default-exported
function, no JSX), so Bun's own TS stripper handles it directly with no
second transform.

The plugin object self-registers at import time (`Bun.plugin(markoPlugin)`
runs at module scope, in addition to the `export default`): `bunfig.toml`'s
`preload = ["@mxlang/translator/bun"]` runs a preloaded module purely for its
side effects — it does **not** call `Bun.plugin` on a default export
automatically — so without the self-registration call, `.mx`/`.marko`
imports silently fall through to Bun's default loader and resolve to the
file's path string, not a compiled function. `Bun.plugin` is idempotent for
an already-registered plugin object, so `import markoPlugin from
"@mxlang/translator/bun"; Bun.plugin(markoPlugin)` (the programmatic form)
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
`@mxlang/typescript-plugin`'s role for `.solid.mx`), which is the phase-3
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
`workspaces` includes `examples/*`, so `@mxlang/vite-plugin` and
`@mxlang/parser` resolve as workspace deps, and root `typecheck` covers
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
component; real per-export types arrive with `@mxlang/typescript-plugin`'s
virtual-`.tsx` projection (spec section 7.2).

`examples/mx-site` is a plain-string example: a Hono-on-Bun server and a
static build both rendering MX (`.mx`) templates via
`@mxlang/translator/bun` (the Bun loader — see its own section above), no
Solid, no client runtime, no prebuild step. `src/server.ts` and
`src/build.ts` `import renderX from "./pages/x.mx"` directly, exactly like
any other module; `bunfig.toml` preloads the loader.

`packages/translator/tsconfig.json` maps `@mxlang/parser` to
`../mx-parser/src/public.d.ts` in its `paths`, for typechecking against the
parser's public types without requiring `dist/` to be built first. Bun's
`bun run` also honours `tsconfig.json` `paths` at runtime, and does so per
imported file's own directory, not just the entry point's — so a plain `bun
run` of any script that imports `@mxlang/translator` (which imports
`@mxlang/parser`) fails with `Export named 'X' not found in module
".../public.d.ts"`, because Bun resolves the bare `@mxlang/parser` specifier
against `packages/translator/tsconfig.json`'s `paths` regardless of where the
importing file lives. Work around it with `bun run
--tsconfig-override=<path to a tsconfig with no such paths>`; `examples/mx-site`'s
`dev` and `build` scripts do this against the root `tsconfig.base.json`. This
is a property of `translator`'s tsconfig, not a bug in `@mxlang/translator`
itself or in Bun's resolver generally — vitest is unaffected because it does
not resolve bare specifiers through `tsconfig.json` `paths` the same way.

`examples/astro-static` is the Astro host's example: an Astro 7.3.2 site
(`output: "static"`, pinned exact in its own `package.json`) with `.mx`
components — props and a default slot, a named slot, and one component
composed from another with a `.marko` alias import inside — and, per decision
76b, `.mx` **pages** directly under `src/pages`: `mx-page.mx` (a `layout`
export, props from a `static` block, `<if>`, `<for>`), `no-layout.mx` (no
`layout`, writes its own full document), and `posts/[slug].mx` (`getStaticPaths`
returning two entries, `prerender = true`).

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run e2e        # headless Chromium over dist/, plus the two error builds
```

Its `e2e/` holds two specs. `pages.spec.ts` builds once, serves `dist/` over a
bare `node:http` server and asserts the rendered HTML (the same Vitest-driving-
raw-playwright shape as `examples/mx-vite/e2e/pages.spec.ts`) for every
component page and every `.mx` page (layout applied, static-block props,
`<if>`/`<for>`, both `getStaticPaths` entries, `input.params.slug` reaching
the dynamic route), including that no page contains a `<script>` — the host's
whole claim. `build-errors.spec.ts` asserts the two builds that must fail:
`<let>` in an MX component (the strict policy) and `client:load` on an MX
component (the renderer's own error, since Astro raises none — see the
package section above). Both pages live in `error-fixtures/`, **outside**
`src/pages/`, and each is copied in for a single build and removed afterwards
— a page that is meant to break the build cannot also be part of the build
every other test depends on. `vitest.config.ts` sets `fileParallelism: false`,
since each spec runs a real `astro build`.

**`.mx` pages** (decision 76b, `packages/astro/src/index.ts` +
`packages/astro/src/vite-pages.ts`): the integration calls Astro's
`addPageExtension(".mx")` — `.marko` is deliberately not registered as a page
extension, staying a component-only alias. A second Vite plugin (`mxPages`,
`enforce: "post"`, scoped to `<srcDir>/pages/`) runs after
`@mxlang/vite-plugin`'s own `.mx` → TS compile in the *same* transform pass
and rewrites the already-compiled module — by the time this stage runs the
bundler has already stripped TypeScript types from the code (measured: no
`: Input`/`: string` annotations survive), so the rewrite injects plain JS,
not TS. It matches `@mxlang/translator`'s exact branded tail (`function
render(input) {...}; Object.defineProperty(render,
Symbol.for("mx.component"), ...); export default render;` — see
`translate.ts`'s `brandRender`) and replaces it with an Astro
`createComponent` factory built with Astro's own
`renderTemplate`/`renderComponent`/`unescapeHTML` runtime helpers
(`astro/runtime/server/index.js`), never a hand-rolled factory invocation —
`renderComponent` is the same helper a compiled `.astro` template uses to
call a nested component, so this stays correct if Astro's factory-calling
convention changes shape. `input` is `{ ...props, params: astro.params, url:
astro.url }`, `astro` obtained via `result.createAstro(props, slots)`
(verified against `astro/dist/types/public/internal.d.ts`). A page's `export
const layout = "...";` (a string literal, matched and stripped from the
compiled module) is turned into a real `import` of that `.astro` file, and
every other top-level `export const NAME = ...;` the page declares becomes a
`frontmatter` key passed to the layout, mirroring Markdown's own `layout`
behaviour (`astro/dist/vite-plugin-markdown`).

This rewrite is possible at all only because `@mxlang/core`'s `emitStatement`
(`packages/core/src/core.ts`) now hoists **any** `export` statement — not
only `export interface Input` — to real module scope verbatim, the same way
it already hoists `import`. Before this change, an MX file's TypeScript
section could only ever `export interface Input`; any other top-level
`export` was a hard compile error ("a standalone template may only `export
interface Input`..."). This was a shared-core change (not `translate.ts`'s
`brandRender`, which `oracle-shape` owns) needed so a page's `export const
getStaticPaths = ...`/`export const prerender = ...` can reach Astro's router
as real named exports of the compiled module, exactly as a `.astro` page's
own frontmatter does.

`examples/mx-vite` is a minimal static-site build exercising
`@mxlang/vite-plugin`'s `.mx` handling (not `.solid.mx`): two `.mx` pages
under `src/pages/`, a tiny `src/build.ts` that imports both and writes
`dist/*.html`, and a `vite.config.ts` whose `build.ssr` is that script rather
than a browser entry — `vite build` bundles it through the plugin's
`.mx`/`.marko` transform, then `bun run dist-ssr/build.js` actually runs it
and writes the
HTML. `vite.config.ts`'s `ssr.external: ["@mxlang/translator"]` keeps that
package's own `import { escape } from "@mxlang/translator"` (present in
every compiled `.mx` page) out of the rolldown bundle — left un-external,
rolldown would try to bundle `@mxlang/translator`'s raw TS source itself,
pulling in `@marko/compiler`'s transitive syntax the same way the plugin's
own dynamic `import()` has to route around (see the Vite plugin section
above).
