# @markox/html

Standalone MX: a string-emitting compile target for `.mx` files. No runtime
beyond one `escape` helper — a `.mx` file compiles to a pure
`(input: Input) => string` function, usable from Express, Hono, Astro
endpoints, email pipelines, or any static-site generator. See
`notes/standalone-mx-parity.md` at the space root for the full JSX/Pug
feature-parity tables, and `notes/standalone-mx-decisions.md` (S1-S7) for the
design decisions behind this package.

## Usage

```ts
import { compile } from "@markox/html";

const { code, map } = compile(source, "greeting.mx");
```

`compile(source, filename)` parses and lowers a `.mx` file to a TS module:

```ts
import { escape } from "@markox/html";
export interface Input { name: string }
export default function (input: Input): string {
  return `<h1>Hello, ${escape(input.name)}</h1>`;
}
```

- `export interface Input` is the author's own, copied verbatim from the
  source file.
- Escaped placeholders (`${expr}`) become `escape(expr)` calls; raw
  placeholders (`$!{expr}`) interpolate without escaping.
- Void elements self-close per HTML.
- Components are plain imports called as functions returning `string`;
  attribute-tag children (`<@name>`) become named function props on the call.
- `<const/x=...>` emits a `const` at render scope; `static` blocks and
  `import`s hoist to module scope.
- String building concatenates into a local rather than joining an array —
  competitive under V8 string ropes, and the emitted code stays readable
  (the golden fixtures diff it directly).

## API

- `compile(source: string, filename: string): { code: string, map: ... }` —
  parses and lowers a `.mx` file to the module shape above.
- `escape(value: unknown): string` — escapes the five HTML text/attribute
  characters `& < > " '`. Non-string values are `String()`-coerced;
  `null`/`undefined` render as the empty string, not the literal words
  `"null"`/`"undefined"`.

## Fixtures

Golden fixtures live at `fixtures-mx/<name>/`, one directory per capability:

- `input.mx` — the MX source.
- `input.json` — the `Input` value passed to the compiled function.
- `expected.html` — the expected rendered output.

The vitest harness (`fixtures.test.ts`) discovers every directory under
`fixtures-mx/` automatically — adding a fixture needs no harness change
unless it requires a second `.mx` file (component import, `include`, layout),
in which case that file sits alongside `input.mx` in the same directory.

## Parity

`notes/standalone-mx-parity.md` (space root, not part of this repo) maps
every JSX and Pug feature to its MX spelling and the fixture that proves it,
or states why it is not supported. The short version: standalone MX has no
reactive runtime — `<let>`, `<effect>`, `<await>`, and two-way binding are
not supported here (they exist only in the Solid target). Everything else in
Pug and JSX has an MX spelling; that note's "Caveats" section lists the
implementation gaps found while proving that — comments are always dropped
(both `<!-- -->` and `//`), calling a `<define>` as a tag is broken for
**any** parameter count of one or more (not just multi-parameter — a single
plain-value parameter also breaks, and a single block parameter throws),
a bare escaped placeholder as the first content in a template is misparsed
as a dynamic tag name and throws, a bare raw placeholder in that same
position silently miscompiles instead of throwing, and `by=` on `<for>`
is silently accepted and ignored rather than rejected (it is meant to be a
parse error — no fixture exercises it as of this package's current state).
None of those are fixed here; they are tracked as findings, not silently
worked around.
