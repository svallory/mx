# Upstream: `tree-sitter-typescript`

This package vendors the tsx dialect of `tree-sitter-typescript` and patches it
so that `<` in expression position opens an MX region rather than JSX.

## Pin

| Field | Value |
|---|---|
| Repository | `https://github.com/tree-sitter/tree-sitter-typescript` |
| Tag | `v0.23.2` |
| Commit | `f975a621f4e7f532fe322e13c4f79495e0a7b2e7` |
| Date | 2024-11-10 |

`v0.23.2` is the latest *tag*. `main` has moved ahead (`75b3874`, 2025-01-30)
but is untagged; the pin follows the tag deliberately.

`vendor/` is not committed (see `.gitignore`) — it is reconstructed from this
pin plus `patches/` by `scripts/vendor.sh`. What *is* committed is the generated
output in `src/`, because Zed compiles that directly and never runs
`tree-sitter generate`.

## Toolchain used to generate the committed output

| Tool | Version |
|---|---|
| `tree-sitter-cli` | **0.24.7** |
| `tree-sitter-javascript` | 0.23.1 |

Both are exact-pinned devDependencies (no `^`/`~`), matching the repo's
exact-pin policy. `tree-sitter-typescript` v0.23.2 declares
`tree-sitter-cli: ^0.24.4`, so 0.24.7 is inside upstream's own supported range.

**Regenerating with a different CLI produces a different `src/parser.c`.** That
shows up as a large spurious diff, so bump the CLI deliberately and say so in
the PR — never let it drift as a side effect.

`tree-sitter` is not on PATH on the operator's machine. Every script invokes it
through the package manager (`bunx tree-sitter`); no script may assume a global
binary.

## Layout

- `common/define-grammar.js` — the real grammar, as a function of dialect,
  extending `tree-sitter-javascript`. **This is the only file MX patches.**
- `common/scanner.h` — the shared external scanner. Vendored **untouched**; the
  MX scanner lives in `src/scanner_mx.c` so an upstream rewrite of this file
  fails loudly at the vendor step instead of silently merging into MX code.
- `tsx/grammar.js` — two lines calling `defineGrammar('tsx')`. MX's own
  `grammar.js` at the package root plays this role, calling
  `defineGrammar("tsx", "solidmx")`.

`tsx/src/parser.c` is ~8.4 MB upstream and MX's generated `src/parser.c` is
~8.1 MB. First clang compile is slow (tens of seconds); that is a known,
expected cost of `tree-sitter test` / `parse` / `highlight` after a regenerate,
not a symptom of a problem.

## Local modifications

All of them live in `patches/*.patch`, produced with `git format-patch` and
applied by `scripts/vendor.sh`. There is exactly one patch, touching only
`common/define-grammar.js`:

1. **`externals`** — declare `mx_element`, the opaque whole-region token.
2. **`expression`** — in the `tsx` branch, drop `_jsx_element` (the choice of
   `jsx_element` / `jsx_self_closing_element`) and add `mx_element` in its
   place. This is what makes `<` in expression position start MX, not JSX.
3. **`defineGrammar(dialect, name = dialect)`** — take the grammar *name* as a
   second parameter. The generated C symbols derive from the name
   (`tree_sitter_solidmx_external_scanner_scan`), so SolidMX must be named
   `solidmx` while still selecting every `tsx` dialect branch. Defaulting to
   `dialect` leaves upstream's own two grammars unaffected.

### Deliberately NOT carried over

Upstream declares `[$.jsx_opening_element, $.type_parameter]` in `conflicts` so
GLR can explore both `<T,>(x) => x` and `<div>`. MX declares **no** equivalent
for `mx_element`, and adding one is an error rather than harmless: `mx_element`
is a single external *token*, so the decision is made in the lexer and never
reaches a GLR fork. `tree-sitter generate` reports the declaration as
`Warning: unnecessary conflicts`.

**Where the `<T,>` / `<T extends U>` check actually happens:** in the lexer's
external-then-internal fallback — at a `<` in expression position tree-sitter
offers the external `mx_element` first, the scanner scans forward for a matching
close tag, finds none before the input ends, and returns false, whereupon
tree-sitter re-lexes the same position internally and the ordinary `<` token
yields `type_parameters`.

So a generic arrow is rejected by the scanner *failing to find an element*, not
by any lookahead, precedence or conflict. Verified with `tree-sitter parse
--debug`: at the `<` of `<T,>(x: T) => x` the trace shows `lex_external` running
and consuming to end-of-line, then `lex_internal` re-lexing from the original
column and emitting `sym:<`. An instrumented build confirms the scanner *is*
offered that position (so `valid_symbols` is not what declines it).

`test/corpus/generics.txt` pins both directions: `<T,>`, `<T extends U>` and
`<A, B>` parse as `type_parameters`, while `<div>` and `<div.card>` parse as
`mx_element`.

## Bump procedure

1. Update `PIN_SHA` / `PIN_TAG` in `scripts/vendor.sh` and the table above.
2. `./scripts/vendor.sh` — fetches the new pin and applies `patches/`. If a
   patch does not apply, upstream moved under it: rebuild the patch rather than
   editing `vendor/` by hand.
3. Re-check the external token order. `src/scanner_mx.c`'s `enum MxTokenType`
   holds *indices into `valid_symbols`* and must match `src/grammar.json`'s
   `externals` array exactly:

   ```sh
   python3 -c "import json; print([e.get('name') or e.get('value') for e in json.load(open('src/grammar.json'))['externals']])"
   ```

   An off-by-one here is silent — the scanner reads another token's flag, never
   fires, and every MX region degrades to a TypeScript parse error. This
   actually happened during development.
4. `bun run generate` (takes the `flock /tmp/mx-zed-generate.lock` lock).
5. `bun run test` — corpus, then the parse and highlight gates.
6. Commit the regenerated `src/` and record the CLI version above if it changed.

## Drift detection

`./scripts/vendor.sh --check` re-fetches the pin into a temporary directory,
applies `patches/`, and diffs the result against `vendor/` for the three files
the build consumes. It exits non-zero on any difference, so a hand-edit to
`vendor/` that was never captured as a patch — the edit the next re-vendor would
silently revert — fails the check instead of surviving to surprise someone.
