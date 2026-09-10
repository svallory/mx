# @markox/html

Standalone MX: a string-emitting compile target for `.mx` files. No runtime
beyond one `escape` helper — a `.mx` file compiles to a pure
`(input: Input) => string` function, usable from Express, Hono, Astro
endpoints, email pipelines, or any static-site generator. See
`notes/standalone-mx-parity.md` at the space root for the full JSX/Pug
feature-parity tables, and `notes/standalone-mx-decisions.md` (S1-S7) for the
design decisions behind this package.

## Usage

The everyday path is importing a `.mx` file directly and calling the default
export — no manual `compile()` call, no generated file on disk:

```ts
import page from "./greeting.mx";

page({ name: "Ada" }); // "<h1>Hello, Ada</h1>"
```

Two loaders make that import resolve, one per runtime:

- **Bun**: `@markox/html/bun` is a `BunPlugin` that intercepts `.mx` imports
  and compiles them on the fly. Register it once via `bunfig.toml`:

  ```toml
  preload = ["@markox/html/bun"]
  ```

  or at runtime with `Bun.plugin`:

  ```ts
  import mxPlugin from "@markox/html/bun";
  Bun.plugin(mxPlugin);
  ```

  See `examples/mx-site` for a full app built this way.

- **Vite**: `@markox/vite-plugin`'s `mx()` plugin handles `.mx` alongside
  `.solid.mx` — add it to `plugins` and import `.mx` files as usual. See
  `examples/mx-vite`.

`import page from "./x.mx"` typechecks against the ambient declaration in
`types/mx.d.ts`:

```ts
declare module "*.mx" {
  const render: (input: any) => string;
  export default render;
}
```

Reference it from a consumer's `tsconfig.json` `include` (both loaders'
example apps do this) — it types every `.mx` import as `(input: any) => string`.
`any`, not each file's real `Input` interface: per-file typing needs a virtual-
file projection of the compiled module, which is the phase-3 language
server's job (see `@markox/typescript-plugin`'s equivalent role for
`.solid.mx`), not something this ambient declaration can derive on its own.

For anything that needs the compiled code directly — writing it to disk,
a bundler integration, tooling — `compile()` is the lower-level API both
loaders are built on:

```ts
import { compile } from "@markox/html";

const { code, map } = compile(source, "greeting.mx");
```

`@marko/compiler` parses, validates and supplies the tag registry; this
package supplies only the translator (ADR 0001). `compile(source, filename)`
drives it and returns a TS module:

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
- A tag name is a component call when it matches an in-scope binding — an
  `import` or a `<define>` — **regardless of case**; any other tag name is an
  HTML element, whatever its case (hyphenated custom elements included). This
  is Marko's own rule, not an MX invention: `import layout from "./layout.mx"`
  then `<layout>` calls the component, while `<my-widget>` with no matching
  binding stays a literal element. A `<define>` shadows a real HTML element
  of the same name for the rest of the file — `<define/section|x|>` makes
  `<section>` call the define, not emit `<section>`, so naming a `<define>`
  after a common element makes that element uncallable as a tag afterward. A
  capitalized tag with no matching binding is a compile error rather than a
  literal element, since no HTML element is ever capitalized — it can only be
  a missing or misspelled import/define.
- `<const/x=...>` emits a `const` at render scope; `static` blocks and
  `import`s hoist to module scope.
- String building concatenates into a local rather than joining an array —
  competitive under V8 string ropes, and the emitted code stays readable
  (the golden fixtures diff it directly).

## API

- `compile(source: string, filename: string): { code: string, map: ... }` —
  compiles a `.mx` file to the module shape above, by running MX's translator
  under `@marko/compiler`. The returned map is an identity placeholder for
  now: the translator builds text directly rather than printing an AST.
- `TranslateError` — thrown for a construct that parses as Marko but has no
  string lowering, carrying `line`/`column`.
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
reactive runtime — `<let>`, `<effect>`, `<script>`, `<lifecycle>`,
`<await>`, `<try>`, `<client>`, `<server>` and two-way binding (`:=`) are
not supported here (they exist only in the Solid target). Each raises a
translate-stage error naming the construct rather than being dropped
silently, and each has a test pinning its message.

The gaps that note's "Caveats" section once listed are closed and pinned by
fixtures and tests: HTML comments survive (only `//` line comments are
author-only), calling a `<define>` as a tag passes its arguments positionally
for any parameter count, a bare placeholder as a template's first content
compiles as a placeholder in both the escaped and raw forms, and `by=` on
`<for>` is a translate error naming the reason.
