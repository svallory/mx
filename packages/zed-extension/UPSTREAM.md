# Upstream provenance

`packages/zed-extension` ships one language for Zed:

- `SolidMX`, backed by this monorepo's own `packages/tree-sitter-solidmx` — a
  patched `tree-sitter-typescript` (tsx dialect) with an `mx_element`
  external token in expression position. That package's own `UPSTREAM.md`
  owns its `tree-sitter-typescript` pin and patch; this file only records how
  its output is wired into the extension.

The `MX` language (`.mx`, backed by the unmodified `marko-js/tree-sitter`
grammar) was retired per decision 68 in `notes/decisions-2026-09-10.md` — the
`.mx` dialect does not exist any more, and plain `.marko` files are covered
by Zed's official `marko-js/zed` extension. See "SolidMX injection
prerequisite" below for the one place that removal touches this package's
own behavior.

## Pins

| Source | Repo | Rev | What's taken |
|---|---|---|---|
| SolidMX grammar | `packages/tree-sitter-solidmx` (in this monorepo) | working-tree HEAD, referenced by `extension.toml`'s `[grammars.solidmx]` `rev` as a **committed sha** (dev form: `file://` + `path`) | Zed clones this monorepo at that sha and compiles `packages/tree-sitter-solidmx/src/{parser.c,scanner_mx.c,scanner.c}`. Also the source of `queries/highlights.scm`, copied (not fetched over the network — it's a local sibling package) by `scripts/vendor.sh` into `languages/solidmx/highlights.scm`. |

`extension.toml`'s `name` and `description` are hand-written; `id = "markox"`
is unchanged from when the extension also shipped `MX`, since the extension
id is a publishing identity, not a language name.

SolidMX has no equivalent of `marko-js/zed` to source `injections.scm`,
`brackets.scm` and `outline.scm` from — no reference Zed extension for this
grammar exists. Those three query names' base content is hand-authored in
`base/solidmx/*.scm` (see "Local modifications" below).

## Local modifications

`languages/solidmx/highlights.scm` is
`packages/tree-sitter-solidmx/queries/highlights.scm` (that package's own,
already-final query — see its `UPSTREAM.md`) plus
`overlay/solidmx/highlights.scm` concatenated on. `injections.scm`,
`brackets.scm` and `outline.scm` have no upstream source at all, so their
base content lives in this package's own `base/solidmx/*.scm` (hand-authored,
reviewed like any other source file) with `overlay/solidmx/*.scm`
concatenated the same way. All four SolidMX overlay files are currently
empty: the base content already covers every node the grammar emits.

`base/solidmx/injections.scm` injects the `marko` language into `mx_element`
(MX and SolidMX share syntax) so the otherwise-opaque region highlights
instead of remaining plain text.

### SolidMX injection prerequisite (post-68)

`base/solidmx/injections.scm` sets `injection.language "marko"`. Zed resolves
an injected language by matching that string against an **installed**
language's own name (case-insensitively) — it is not a reference to a
grammar this extension declares. Since `MX` (this package's own `marko`-named
language) was dropped, the only language that can satisfy this injection is
Zed's official `marko-js/zed` extension, whose `languages/marko/config.toml`
declares `name = "Marko"` (confirmed by reading that file at its published
rev). "Marko" lowercases to "marko", so the match holds — **but only when
that extension is installed**. Without it, `mx_element` regions in a
`.solid.mx` file fall back to unhighlighted plain text; this is a missing
prerequisite, not a bug in this package. `extension.toml` deliberately keeps
no `[grammars.marko]` pin of its own for this — the injection needs a
language name to resolve against, not a grammar this package compiles, and
duplicating `marko-js/zed`'s grammar here would fetch and compile the same
tree-sitter grammar twice for no benefit. See `README.md` for the
user-facing prerequisite note.

`extension.toml` deliberately omits `[language_servers.marko]`, `src/lib.rs`
and `Cargo.toml` — a grammar-only extension needs no Rust build (Zed's
`extension_builder.rs` only runs the Rust build when `Cargo.toml` exists).

## Bump procedure — SolidMX

SolidMX has two independent "bumps": the grammar itself (owned by
`packages/tree-sitter-solidmx`) and this extension's wiring to it.

**Grammar change** (new scanner fix, new upstream `tree-sitter-typescript`
pin, etc.) — see `packages/tree-sitter-solidmx/UPSTREAM.md`'s own bump
procedure. That package's changes must land as **committed** commits before
they can reach Zed at all (see "A note on the `file://` dev loop" below).

**Extension wiring change** (this package):

1. If `packages/tree-sitter-solidmx/queries/highlights.scm` changed, or
   `base/solidmx/*.scm` needs updating for a new node the grammar now emits:
   edit the source (the grammar package's file, or this package's
   `base/solidmx/*.scm` — never `languages/solidmx/*.scm` directly).
2. Regenerate: `./scripts/vendor.sh` (no args). This rewrites
   `languages/solidmx/*.scm` from `packages/tree-sitter-solidmx`'s highlights
   query, `base/solidmx/*.scm`, and `overlay/solidmx/*.scm`.
3. If the grammar itself changed (new commit under
   `packages/tree-sitter-solidmx`): `git rev-parse HEAD` and update
   `extension.toml`'s `[grammars.solidmx]` `rev` to the new sha — see
   `README.md`'s "Dev install (Zed) — SolidMX" for the full commit-then-bump
   loop.
4. Reinstall the dev extension in Zed and spot-check highlighting, bracket
   matching, outline, and the `marko` injection on a `.solid.mx` file (needs
   the official `marko-js/zed` Marko extension also installed — see
   "SolidMX injection prerequisite" above).
5. Commit `languages/solidmx/*.scm`, any changed `base/solidmx/*.scm`,
   `extension.toml` (if `rev` moved), and this file together.

### A note on the `file://` dev loop

Because `[grammars.solidmx]`'s `rev` must be a real commit sha, **there is no
way to iterate on the grammar and see the result in Zed without committing
first.** Expect to commit more often than feels natural while iterating on
`packages/tree-sitter-solidmx` under active Zed testing — that is the cost of
a `file://` dev dependency, not a workflow mistake.

## No `vendor.sh --check`

This script has no `--check` mode (the retired MX language's version did —
it compared `marko-js/tree-sitter`/`marko-js/zed` pins against upstream
HEAD). SolidMX's `highlights.scm` source is `packages/tree-sitter-solidmx`, a
local sibling package with no networked upstream HEAD to drift against, so a
"check" mode here could only ever report success — decision 55: a gate that
cannot fail is not a gate. `moon.yml`'s `vendor-check` task and
`package.json`'s `vendor:check` script were removed along with it.
`.github/workflows/upstream-check.yml`'s `vendored-files-match` job is the
real check: it regenerates and diffs against committed output.
