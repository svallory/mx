# @markox/translator

## 0.1.0 (unreleased)

Policy (decision 65, 67): the target renders what Marko's own server render
would emit, minus resume markers — `<let>`/`<const>`/`:=` evaluate their
initial value, `<effect>`/`<lifecycle>`/`<script>`/`client`/`<id>` are inert,
a `server` block runs and hoists, and `<await>`/`<try>`-with-`<@placeholder>`/
`<return>` error because a synchronous `(input) => string` genuinely cannot
express them. An opt-in `strict` policy instead rejects the reactive
constructs by name. Attribute values are always double-quoted rather than
byte-matching Marko's quote-minimizer — the oracle compares parsed, decoded
attributes, not source bytes, so the two are already semantically identical
and the always-quoted form is safer and more readable.

- **fix:** a lowercase tag naming a local binding (`import layout from
  "./layout.marko"` then `<layout>`) now errors with Marko's own message
  ("Local variables must be in a dynamic tag unless they are PascalCase...")
  instead of being called directly. `<${layout}/>` and `<Layout/>` are
  unaffected.
- **fix:** an unresolved hyphenated tag (`<my-widget>` with no taglib entry)
  now errors with Marko's own message ("Unable to find entry point for
  custom tag...") instead of rendering as literal HTML.
- **build:** publishable from `dist/` (ESM + `.d.ts`); `exports` map for
  `.` and `./bun`.

Scope note (decision 74): the org is renaming `@markox` to `@mxlang`. This
package will publish as `@mxlang/translator` once that rename lands across
the workspace (a separate `org-rename` task); until then its `package.json`
`name`, the `escapeFrom` string baked into every compiled template's
`import { escape } from "..."`, and every in-repo consumer specifier stay
`@markox/translator`, so the published name and the runtime import never
drift apart mid-migration.
