# Upstream provenance

`packages/zed-extension` ships two languages for Zed:

- `MX`, backed by the **unmodified** `marko-js/tree-sitter` grammar (MX and
  Marko share syntax; MX's compiler is stricter about what it accepts, but
  the parser doesn't need to know that — see `notes/zed-extension-plan.md`
  decision 3).
- `SolidMX`, backed by this monorepo's own `packages/tree-sitter-solidmx` — a
  patched `tree-sitter-typescript` (tsx dialect) with an `mx_element`
  external token in expression position. That package's own `UPSTREAM.md`
  owns its `tree-sitter-typescript` pin and patch; this file only records how
  its output is wired into the extension.

## Pins

| Source | Repo | Rev | What's taken |
|---|---|---|---|
| MX grammar | `marko-js/tree-sitter` | `7fb20382b9b0c97c8bdbceee0e0641bea11dd00f` (`@marko/tree-sitter` v0.2.0, 2026-06-26) | Referenced directly by `extension.toml`'s `[grammars.marko]` — Zed clones and compiles it itself, nothing copied into this repo. Also the source of `queries/highlights.scm` and `queries/injections.scm`, concatenated by `scripts/vendor.sh` into `languages/mx/highlights.scm` / `injections.scm`. |
| MX extension reference | `marko-js/zed` | `dd854edec1fab86d23eb24af9691505dfe3856a6` (2026-08-20, latest of 3 commits) | `languages/marko/brackets.scm` and `languages/marko/outline.scm` — `marko-js/tree-sitter` ships neither, so these two query files have no home in the grammar repo and come from the reference Zed extension's own copies instead. Concatenated by `scripts/vendor.sh` into `languages/mx/brackets.scm` / `outline.scm`. |
| SolidMX grammar | `packages/tree-sitter-solidmx` (in this monorepo) | working-tree HEAD, referenced by `extension.toml`'s `[grammars.solidmx]` `rev` as a **committed sha** (dev form: `file://` + `path`) | Zed clones this monorepo at that sha and compiles `packages/tree-sitter-solidmx/src/{parser.c,scanner_mx.c,scanner.c}`. Also the source of `queries/highlights.scm`, copied (not fetched over the network — it's a local sibling package) by `scripts/vendor.sh` into `languages/solidmx/highlights.scm`. |

`marko-js/zed`'s `extension.toml`, `src/lib.rs`, `Cargo.toml`/`Cargo.lock`, and
`languages/marko/config.toml` are **not** vendored — this package is
grammar-only (no Rust, no language server; see "Local modifications" below)
and `languages/mx/config.toml` / `languages/solidmx/config.toml` are
hand-written for each language's own suffixes and comment/bracket
conventions, not copied.

SolidMX has no equivalent of `marko-js/zed` to source `injections.scm`,
`brackets.scm` and `outline.scm` from — no reference Zed extension for this
grammar exists yet. Those three query names' base content is instead
hand-authored in `base/solidmx/*.scm` (see "Local modifications" below) and
concatenated the same way by `scripts/vendor.sh`.

## Local modifications

**MX**: none to the grammar or to the vendored query text itself — every
`.scm` file under `languages/mx/` is upstream content plus an
`overlay/mx/*.scm` file concatenated on by `scripts/vendor.sh`, never
hand-edited in place. The four overlay files are currently empty (MX uses the
Marko grammar unmodified, so upstream's queries already cover every node MX
emits) but exist so a future MX divergence has somewhere to go without
churning vendored content — see `scripts/vendor.sh`'s header comment.
`patches/*.patch` (applied by `vendor.sh` with `git apply` before overlay
concatenation) is empty for the same reason: nothing needs patching yet.

**SolidMX**: `languages/solidmx/highlights.scm` is
`packages/tree-sitter-solidmx/queries/highlights.scm` (that package's own,
already-final query — see its `UPSTREAM.md`) plus
`overlay/solidmx/highlights.scm` concatenated on. `injections.scm`,
`brackets.scm` and `outline.scm` have no upstream source at all, so their
base content lives in this package's own `base/solidmx/*.scm` (hand-authored,
reviewed like any other source file — not fetched, not patched) with
`overlay/solidmx/*.scm` concatenated the same way as MX's overlays. All four
SolidMX overlay files are currently empty for the same reason as MX's: the
base content already covers every node the grammar emits.
`base/solidmx/injections.scm` injects the `marko` language into `mx_element`
(MX and SolidMX share syntax; see `notes/zed-extension-plan.md` decision 4)
so the otherwise-opaque region highlights as MX rather than plain text.

`extension.toml` deliberately omits `[language_servers.marko]`, `src/lib.rs`
and `Cargo.toml` — `marko-js/zed`'s reference extension carries a Rust build
that installs `@marko/language-server`, but that server doesn't know MX, and
dropping it is what makes a grammar-only extension possible in the first
place (see `notes/zed-extension-decisions.md` Z5: Zed's
`extension_builder.rs` only runs the Rust build when `Cargo.toml` exists).
The same applies to SolidMX: no language server, no Rust, for the same
reason.

## Bump procedure — MX

1. Check for drift: `bunx tree-sitter --version` (see below) then
   `./scripts/vendor.sh --check`, or `bun run vendor:check` from this
   package. Non-zero exit means a rev below is behind upstream HEAD; it
   prints which one(s) and by how much.
2. Decide the new pin: usually upstream's current default-branch HEAD. Update
   `TS_REV` and/or `ZED_REV` at the top of `scripts/vendor.sh`, and if the
   grammar rev changed, `extension.toml`'s `[grammars.marko]` `rev` too — the
   two must always match.
3. Regenerate: `./scripts/vendor.sh` (no args). This rewrites
   `languages/mx/*.scm` from the new pins, patches, and overlays. Never
   hand-edit those four files directly — edit `overlay/mx/*.scm` or add a
   `patches/<name>.patch` instead, then rerun.
4. Update the pin table above (rev, date) and this file's "Bump procedure"
   section if the procedure itself changed.
5. Reinstall the dev extension in Zed (see `README.md`) and spot-check
   highlighting/brackets/outline on a `.mx` file.
6. Re-run the fixture parse check: `./scripts/parse-fixtures.sh` — a bump
   that introduces new ERROR/MISSING nodes on previously-clean fixtures is a
   real grammar regression worth flagging upstream, not something to patch
   around locally.
7. Commit `languages/mx/*.scm`, `scripts/vendor.sh`, `extension.toml`, and
   this file together.

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
   matching, outline, and the `marko` injection on a `.solid.mx` file.
5. Commit `languages/solidmx/*.scm`, any changed `base/solidmx/*.scm`,
   `extension.toml` (if `rev` moved), and this file together.

### A note on the `file://` dev loop

Because `[grammars.solidmx]`'s `rev` must be a real commit sha, **there is no
way to iterate on the grammar and see the result in Zed without committing
first.** This differs from MX, whose grammar is someone else's
already-published repository: MX's dev loop never has an "uncommitted"
question to answer. Expect to commit more often than feels natural while
iterating on `packages/tree-sitter-solidmx` under active Zed testing — that
is the cost of a `file://` dev dependency, not a workflow mistake.

## Tooling pin

`tree-sitter-cli` is pinned as an exact-version devDependency
(`package.json`, `0.26.9`) rather than assumed to be on `PATH` — it is not,
on the operator's machine (brew has 0.26.12 installed but unlinked; npm
publishes 0.27.0 as latest). `0.26.9` matches `marko-js/tree-sitter`'s own
`^0.26.9` devDependency pin at the vendored rev. `scripts/parse-fixtures.sh`
invokes it via `bunx --package tree-sitter-cli@0.26.9 tree-sitter`, never a
bare `tree-sitter`. Every fixture parse in this repo was run against this
exact CLI version — a different CLI version can produce different
ERROR/MISSING behavior on the same grammar rev, which would show as false
drift if compared against a differently-versioned run.
