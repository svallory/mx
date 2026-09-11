# Divergences from Marko

Decision 72: MX 1.0 is a strict subset of Marko syntax. Every MX 1.0 file is
a valid Marko file with the same meaning for the structural core, and
hosts may only *forbid* a tag they cannot honor, never add syntax, attribute
forms, or file conventions Marko's parser and language server would reject
(decision 71). Divergence from Marko is permitted only from MX 2 on, and only
deliberately: each divergence gets a line below (what, why, test), and a
divergence that changes syntax lands only together with the tooling it
breaks (grammar, Prettier, language server) — until then MX stays a subset.
The real-Marko oracle (`bun run oracle:marko`) remains a regression guard for
the structural core, no longer a contract in itself.

## Recorded divergences

| Divergence | Since | Reason | Test |
|---|---|---|---|
| _(none yet — MX 1.0 has no deliberate divergences)_ | | | |

## Known bugs, not divergences

These are `@mxlang/html` implementation bugs against decision 67's
rule ("the translator should follow Marko"), not intentional divergences.
They are tracked as skipped fixtures under `packages/hosts/html/fixtures-marko/`
with a `translator-bug` reason in each fixture's `meta.json`, not rows above.

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a
  failed custom-element lookup and refuses to compile
  ("Unable to find entry point for custom tag `<my-widget>`", verified
  against `@marko/compiler` 5.42.5 / `marko@6.3.51`). `@mxlang/html`'s
  `isElement` (`translate.ts`) instead treats any hyphenated name as literal
  HTML unconditionally, so it compiles and renders the tag as-is. Fix:
  `isElement` should attempt component resolution for a hyphenated name
  before falling back to a literal element, matching Marko's own
  custom-element lookup.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable
  tag reference outright ("Local variables must be in a dynamic tag unless
  they are PascalCase. Use `<${layout}/>` or rename to `Layout`.", verified
  against the same versions). `@mxlang/html`'s `isComponent`
  (`translate.ts`) is binding-based regardless of case, so it calls the
  import successfully instead of erroring — strictly *more permissive* than
  Marko. Fix: `isComponent` should reject a lowercase local-variable
  reference the same way Marko does.
