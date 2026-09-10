# fixtures

Golden/oracle fixtures for `@mx/oracle` (`packages/oracle`). Exit criterion
this harness checks: byte-parity (whitespace normalized) between compiled
`dom-expressions` output of a `.solid.mx` file and its hand-written `.tsx`
twin, for both Solid generate variants (`dom`/non-hydratable and
`ssr`/hydratable).

## Layout

```
fixtures/
  <name>/
    input.solid.mx      MX source
    twin.tsx             hand-written Solid JSX with equivalent behavior
    README.md             optional, notes about the fixture
    __golden__/
      twin.dom.js          normalized twin.tsx output, generate: "dom"
      twin.ssr-hydratable.js  normalized twin.tsx output, generate: "ssr"
  divergences.md
  README.md (this file)
```

Fixtures are discovered by directory scan (`discoverFixtures` in
`packages/oracle/src/fixtures.ts`); adding a fixture is just adding a
directory with `input.solid.mx` and `twin.tsx`, no code change.

## Adding a fixture

1. `mkdir fixtures/<name>`
2. Write `twin.tsx`: real, working Solid JSX.
3. Write `input.solid.mx`: the MX spelling of the same component, per
   `notes/solidmx-jsx-mapping.md` and `notes/solidmx-spec.md` sections 4-5
   at the space root. If a construct isn't covered by the mapping doc, leave
   `// TODO(mx): unmapped` in the `.solid.mx` file and note it in your PR —
   do not invent MX syntax.
4. Run `bun run oracle` (or `bun run test`) once to write the golden
   snapshots under `__golden__/`. Commit them.
5. A fixture directory must contain both `input.solid.mx` and `twin.tsx`;
   `discoverFixtures` throws if a directory has only one of the two.

## divergences.md

A markdown table (`fixture | variant | reason`) of deliberate, known
differences between a fixture's `.solid.mx` and `.tsx` output. When a
fixture+variant pair is listed here, `compare()` reports status `divergent`
instead of `fail` — the diff is still shown, it just doesn't fail the suite.
Add a row only when the difference is understood and accepted, never as a
way to silence an unexplained failure.

## Golden snapshots

`__golden__/twin.<variant>.js` pins the normalized output of `twin.tsx`
alone (no MX involved). Purpose: catch `babel-preset-solid`/`solid-js` pin
bumps that silently change generated output, independent of whether
`mx-parser` exists yet.

- Written automatically the first time a fixture is compared, if missing.
- To regenerate deliberately (e.g. after a documented pin bump), run
  `bun run oracle -- --update`, which rewrites every golden regardless of
  whether it already exists (`compare()`'s `updateGoldens` option). Never
  let a golden change as a silent side effect of a pin bump — call it out
  in the PR that bumps the pin, and review the diff of the regenerated
  goldens before committing.

## `normalize()`

Defined in `packages/oracle/src/normalize.ts`. What it does, exactly:

- Converts CRLF to LF.
- Collapses runs of spaces/tabs outside string literals (`"..."`, `'...'`)
  and template literals (`` `...` ``, including their `${}` interpolations
  treated as code, not string content) to a single space.
- Comments (`//...` to end of line, `/*...*/`) are copied through verbatim,
  like literals — their contents are never touched, and a quote inside a
  comment never starts string-literal state.
- Trims trailing whitespace from each line.
- Does **not** reorder, rename, delete, or otherwise touch anything else —
  a real difference in generated code always shows up as a diff.

## `skipped` is not `pass`

Until `@mx/parser` exists, every `.solid.mx` compile in this harness throws
`MxParserUnavailable` and is reported as `skipped`. This is the intended red
state: the parser task turns these into `pass`/`fail`/`divergent`. Do not
treat a clean `skipped` run as the oracle passing. `bun run oracle` prints a
loud `ALL SKIPPED` banner whenever every row is skipped as a reminder.

## `bun run oracle` flags

- `--strict` — also fail (non-zero exit) when any row is `skipped`. Use this
  once `@mx/parser` is wired in, to catch a fixture regressing back to
  unparseable.
- `--update` — force-rewrite every golden snapshot, not just missing ones.
  See "Golden snapshots" above.

Flags pass through `bun run`, e.g. `bun run oracle -- --strict --update`.
