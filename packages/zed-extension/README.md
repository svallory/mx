# `markox` — Zed extension

Ships two languages:

- `MX` (`.mx`, the official extension — decision 72) on Marko's own
  unmodified tree-sitter grammar, `[grammars.marko]` pinned to the same rev
  the official `marko-js/zed` extension pins (`7fb20382b9b0c97c8bdbceee0e0641bea11dd00f`,
  `@marko/tree-sitter` v0.2.0). `languages/mx/*.scm` are the official
  extension's `languages/marko/*.scm` copied **verbatim** (no overlay, no
  edits) — MX 1.0 is a strict subset of Marko syntax (decision 72), so
  Marko's own queries apply unmodified. `.marko` is an accepted alias with
  identical treatment; `.marko` files are covered by installing the official
  [`marko-js/zed`](https://github.com/marko-js/zed) extension directly.
- `SolidMX` (`.solid.mx`), backed by `packages/tree-sitter-solidmx` (a
  patched `tree-sitter-typescript` tsx dialect with an `mx_element` external
  token in expression position).

Grammar-only extension: no `Cargo.toml`, no `src/lib.rs`, no language server
of our own (see `UPSTREAM.md` for why; "What you get in Zed today" below for
what that means in practice).

## Zed suffix precedence: `.mx` vs `.solid.mx`

Zed's suffix matcher takes the text after a file's **last** dot as the
extension, then picks the language whose `path_suffixes` entry is the
**longest match**. `MX` declares `path_suffixes = ["mx"]`; `SolidMX` declares
`path_suffixes = ["solid.mx"]`. Both match `Counter.solid.mx` (its last-dot
suffix is `mx`, and `solid.mx` matches too via Zed's own multi-segment suffix
check), so `SolidMX`'s longer, more specific entry wins and the file
resolves to `SolidMX`, not `MX`. Verified by inspection of the existing
`languages/solidmx/config.toml` (already `path_suffixes = ["solid.mx"]` from
when it was the only language shipped here) — no change was needed to keep
this precedence correct when `MX` was added back.

## What you get in Zed today

- `MX` (`.mx`/`.marko`): syntax highlighting, brackets, outline — all from
  Marko's own grammar and queries. **No language server**: Marko's own LS,
  which the official `marko-js/zed` extension registers for its `Marko`
  language, does not attach to files Zed resolves as `MX` — Zed's
  `language_servers` binding is per-language-name, and `[language_servers.*]`
  is declared by the extension that owns the LS binary, not by ours. Installing
  the official Marko extension gives you the LS on `.marko` files (a separate
  extension's language); it does not extend to `.mx`. A future MX diagnostics
  language server (decision 71/72) is a phase-3 item, not part of this task.
- `SolidMX` (`.solid.mx`): syntax highlighting, brackets, outline, and syntax
  highlighting inside `mx_element` regions via the official Marko extension's
  injection (see "Prerequisite" below). No language server either.

## Prerequisite: install the official Marko extension too

A `.solid.mx` file's `mx_element` regions are highlighted by injecting a
language named `"marko"` (`base/solidmx/injections.scm`) — Zed resolves that
by name against installed languages, and the only extension that provides a
language named `Marko` is the official `marko-js/zed` extension. **Install
it from Zed's extension registry (Command Palette → "zed: extensions" →
search "Marko") before installing this dev extension.** Without it,
`mx_element` regions render as unhighlighted plain text — everything else
(the `SolidMX` TypeScript host, brackets, outline) still works.

## Dev install (Zed) — `SolidMX`

`SolidMX`'s grammar lives in this monorepo at `packages/tree-sitter-solidmx`,
so `extension.toml`'s `[grammars.solidmx]` uses the **`file://` dev form**
with `path = "packages/tree-sitter-solidmx"` (Zed clones the whole repo at
`rev`, then looks for `src/` under that `path` — `GrammarManifestEntry.path`
in Zed's own `extension_manifest.rs`).

Even in dev form, Zed still requires a **committed** `rev` — it runs `git
init` + `git remote add origin <url>` + `git fetch --depth 1 origin <rev>` +
`git checkout <rev>` regardless of scheme, so **uncommitted changes under
`packages/tree-sitter-solidmx` are invisible to Zed**. There is no way to
point Zed at a dirty working tree. Zed also never runs `tree-sitter
generate` itself — it compiles whatever `src/parser.c` (and
`src/scanner_mx.c`/`src/scanner.c`) is committed at that rev with clang.

The dev loop is therefore **commit, then bump `rev`, then reinstall**:

1. Make your change under `packages/tree-sitter-solidmx` and commit it (in
   this worktree, on this branch).
2. `git rev-parse HEAD` — copy the sha.
3. Update `extension.toml`'s `[grammars.solidmx]` `rev` to that sha.
4. Command Palette → **"zed: install dev extension"** → select this
   directory (`worktrees/main/packages/zed-extension` from the operator's
   space root, i.e. `packages/zed-extension` inside whichever worktree you're
   in — Zed does not watch for live changes; see "Reinstalling after a
   change" below). **Before this step**, also install Zed's official Marko
   extension from the registry (Command Palette → "zed: extensions" → search
   "Marko") — see "Prerequisite" above; without it `mx_element` regions
   render as unhighlighted plain text.
5. Open or create a `.solid.mx` file — it should be recognized as `SolidMX`,
   with the TypeScript host language highlighted, brackets matched, an
   outline of its declarations, and each `mx_element` region highlighted via
   its `marko` injection (requires the official Marko extension — see
   "Prerequisite" above).

**First compile is slow.** `tree-sitter-solidmx`'s generated `src/parser.c`
is ~8.2 MB; clang's first compile of it after a fresh dev-install can take
tens of seconds. This is expected — not a hang.

### Reinstalling after a change

Zed does not watch `extension.toml` or `languages/` for live changes.
After editing anything under `packages/zed-extension` (or bumping
`[grammars.solidmx]`'s `rev`), re-run "zed: install dev extension" and pick
this directory again to reload it.

## Upstream bump procedure

See `UPSTREAM.md` "Bump procedure — SolidMX" for the full steps.
`languages/solidmx/*.scm` are regenerated by `bun run vendor` — from
`packages/tree-sitter-solidmx/queries/highlights.scm` plus this package's own
`base/solidmx/{injections,brackets,outline}.scm` and `overlay/solidmx/*.scm`.
`packages/tree-sitter-solidmx`'s own grammar/scanner bump procedure (a
*different* upstream, `tree-sitter-typescript`) is in that package's own
`UPSTREAM.md`, not here.

There is no `vendor:check` script — SolidMX's highlights source is a local
sibling package, not a networked upstream, so a "check for drift" mode could
only ever report success (decision 55: a gate that cannot fail is not a
gate). `.github/workflows/upstream-check.yml`'s `vendored-files-match` job
does the check that matters instead: regenerate and diff against committed
output.

## Publishing: subtree-split

The Zed extension registry needs a repo whose **root** holds
`extension.toml` (a submodule pinned to a commit, plus an `extensions.toml`
entry — see `notes/zed-extension-plan.md` decision 6). This monorepo's
`packages/zed-extension` is not that shape, so at publish time:

```sh
./scripts/subtree-split.sh              # -> local branch zed-extension-split
git push <markox/zed remote> zed-extension-split:main
```

`git subtree split --prefix=packages/zed-extension HEAD` rewrites every
commit touching that directory into a commit at the repo root, dropping
everything else. It only sees **committed** history, so commit first — the
script refuses to run against a dirty tree. It touches no remote itself, so a
bad split costs only a local branch delete.

Requires the `git-subtree` contrib command (ships with full Git installs, may
need `brew install git` / your distro's `git-extras` or `git`-with-contrib
package if `git subtree --help` reports "not a git command").

**Publish-time URL swap.** Both the dev-install steps above and
`extension.toml`'s `[grammars.solidmx]` comment describe the `file://` form
as temporary: once `packages/zed-extension` is subtree-split into its own
repo and `packages/tree-sitter-solidmx` is published on its own (or the split
repo vendors it), swap `repository` to that repo's real GitHub URL, drop
`path` (its root will already be the grammar root), and commit. Registering
with `zed-industries/extensions` needs the remote form — a registry
submodule cannot point at a contributor's local filesystem.
