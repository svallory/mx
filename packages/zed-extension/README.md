# `markox` — Zed extension

Ships the `MX` language for Zed, backed by the unmodified
`marko-js/tree-sitter` grammar. Grammar-only extension: no `Cargo.toml`, no
`src/lib.rs`, no language server (see `UPSTREAM.md` for why).

`SolidMX` (`.solid.mx`) is not implemented yet — it lands in a follow-up once
`tree-sitter-solidmx` exists. See "Two languages, one extension" below for
what that means for `.solid.mx` files today.

## Dev install (Zed)

MX's grammar is fetched from the remote `marko-js/tree-sitter` repo (not a
local `file://` grammar), so this is Zed's simple case:

1. Open Zed.
2. Command Palette → **"zed: install dev extension"**.
3. Select this directory: `packages/zed-extension`.
4. Zed reads `extension.toml`, clones `marko-js/tree-sitter` at the pinned
   `rev`, compiles its committed `src/parser.c`/`src/scanner.c` with clang,
   and loads `languages/mx/*.scm`.
5. Open or create a `.mx` file — it should be recognized as `MX` with syntax
   highlighting, bracket matching, and an outline (Command Palette →
   "outline: toggle").

No build step, no `moon`/`bun` command needed for this — Zed does the
grammar compile itself. `bun run vendor` (below) only regenerates the
`.scm` query files from upstream; it does not touch the grammar build.

### Reinstalling after a change

Zed does not watch `extension.toml` or `languages/` for live changes.
After editing anything under `packages/zed-extension`, re-run "zed: install
dev extension" and pick this directory again to reload it.

## Upstream bump procedure

See `UPSTREAM.md` "Bump procedure" for the full steps. Short version:

```sh
bun run vendor:check   # or: ./scripts/vendor.sh --check
# on drift:
#   1. edit TS_REV / ZED_REV in scripts/vendor.sh (and extension.toml's
#      [grammars.marko] rev, if the grammar moved)
#   2. bun run vendor    # regenerates languages/mx/*.scm
#   3. reinstall the dev extension in Zed and spot-check
```

## Two languages, one extension (future)

The `markox` extension id is shared with a future `SolidMX` language
(`.solid.mx`, a separate grammar under `packages/tree-sitter-solidmx`, wired
in by a later change). That grammar is a `file://` dependency during
development, which works differently from MX's remote pin:

- Even for a `file://` grammar, Zed still requires a `rev` — it runs `git
  init` + `git remote add origin <url>` + `git fetch --depth 1 origin <rev>`
  + `git checkout <rev>` regardless of scheme. **Uncommitted changes are
  invisible to Zed.**
- The dev loop for that grammar is therefore: commit your change to
  `packages/tree-sitter-solidmx`, note the new commit sha, update
  `[grammars.solidmx]`'s `rev` in `extension.toml` to that sha, then
  reinstall the dev extension. There is no way to point Zed at an
  uncommitted working tree.
- Zed never runs `tree-sitter generate` itself — it compiles whatever
  `src/parser.c` (and `src/scanner.c`, if present) is committed at that rev.

None of this applies to `MX` today: its grammar is the remote,
already-committed `marko-js/tree-sitter` repository, so the plain "install
dev extension → done" flow above is all that's needed.

## A note on `.solid.mx` and `path_suffixes`

`languages/mx/config.toml` sets `path_suffixes = ["mx"]`. Verified against
Zed's matcher (`crates/language/src/available_languages.rs`,
`find_for_file`): it computes a file's "extension" candidate as the text
after the file name's **last** dot — for `Foo.solid.mx` that is `"mx"`,
identical to `Foo.mx`. A double extension is invisible to this matcher; it
only ever sees the final segment. **`.solid.mx` files therefore currently
match `MX`, the same as plain `.mx` files** — there's nothing `path_suffixes`
can do about it alone. When `SolidMX`'s own language config later declares a
longer suffix (`path_suffixes = ["solid.mx"]`), Zed's precedence rule picks
the match with the greater matched length, so `SolidMX` will correctly win
for `.solid.mx` files once that config exists. Until then, opening a
`.solid.mx` file will show it (reasonably, if imprecisely) as `MX`.
