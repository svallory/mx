# @markox/translator

Compiles a **stock `.marko` template** to a pure function: a JS/TS module whose
default export is `(input) => string`, with no runtime beyond an `escape`
helper. No scheduler, no signals, no hydration, no resume markers.

```ts
import { compile } from "@markox/translator";

const { code } = compile(source, "greeting.marko");
```

```marko
// greeting.marko
<h1 class={greeting: true}>Hello, ${input.name}!</h1>
```

```ts
import { escape } from "@markox/translator";

export interface Input {}

export default function (input: Input): string {
  let out = "";
  out += "<h1";
  {
    const value = classValue({ greeting: true });
    if (value !== "") out += " class=\"" + value + "\"";
  }
  out += ">Hello, ";
  out += escape(input.name);
  out += "!</h1>";
  return out;
}
```

This is **stock Marko**, not a dialect: tag discovery through taglibs and
`tags/` directories, Marko's own HTML/SVG/MathML element registry, Marko's
attribute-tag and component conventions. A template written for Marko compiles
here unchanged, and renders the same bytes Marko's own server render produces.

## Usage

The package is a Marko translator, so the compiler's own entry points work:

```ts
import { compileSync } from "@marko/compiler";
import translator from "@markox/translator";

compileSync(source, filename, { translator, output: "html" });
```

Or use the convenience wrappers, which drive the compiler for you:

- `compile(source, filename)` → `{ code, map }`
- `compileFile(filename)` → `{ code, map }`
- `build(filenames)` → `Map<filename, { code, map }>`, a CLI-free build step
- `escape(value)` — the entire runtime, re-exported from `@markox/html`
- `TranslateError` — thrown for a construct with no lowering, carrying
  `line`/`column`

Try it:

```
bun run example                  # renders the `class-object` fixture
bun run example nested-layout    # or any other fixture name
```

## What this proves

`notes/marko-runtime-modes.md` proposes an **expressions-only** output mode for
Marko: `runtime: "none"`, where a template compiles to a plain string function
and the reactive tags become compile-time errors. The argument for it is that
Marko's `html` output *minus the runtime* is already a precompiled template
language with typed TypeScript expressions and a language server — something
Pug, Jinja, Handlebars and EJS never had.

This package is that mode, working, on real Marko templates, without forking
the compiler. The seam is `config.translator`: a translator that supplies only
`translate` and its taglibs injects nothing else, so the emitted module's
runtime surface is one `escape` import (plus, only when a template calls for
it, an inlined `classValue`/`styleValue`/`renderDynamic` helper).

The evidence is `bun run oracle:marko`'s second table: 30 stock `.marko`
fixtures rendered both through the real Marko 6 toolchain and through this
translator, compared for semantic HTML equality. **30 of 30 pass, with no
skips and no recorded divergences.**

### Proposal draft

> **Expressions-only output for Marko (`runtime: "none"`).** Marko's `html`
> output minus the runtime is a complete precompiled template language: typed
> `${}` expressions, real components, the language server, and a compiled
> artifact that is readable JavaScript rather than `_scope`/`_marker` calls. A
> template using only `<if>`, `<for>`, `<let>`, `<const>`, `<define>`,
> attribute tags, `static` and `import` needs nothing at run time but an HTML
> escape helper — roughly 200 bytes — and compiles to
> `(input: Input) => string`, usable from Express, Hono, Workers, email
> pipelines, or a static site generator with zero bundle cost and no render
> API. The reactive constructs (`<effect>`, `<lifecycle>`, `<script>`, `<await>`,
> `:=` as a two-way binding) either become inert or fail at compile time with a
> message naming them, so the boundary is visible to the author rather than
> silent. We have implemented this as a translator against `@marko/compiler`
> 5.42.5 with no compiler changes, and verified it against Marko's own server
> render on 30 stock templates covering components, `tags/` discovery,
> attribute tags, control flow, `class`/`style` object forms, spread, dynamic
> tags and doctype documents: all 30 produce byte-equivalent HTML. The
> implementation is ~700 lines and the runtime is one function. We would like
> to contribute it upstream as an output mode.

## Policy table (decision 65)

The target renders **what Marko's server render would emit, minus resume
markers**. Every construct is classified by one test: does it contribute to the
emitted bytes, or does it only configure behaviour after the first render?

"My code cannot lower this" is never a row in this table. Only "this target
cannot express it" is.

### Inert — accepted, contributes no output

Each was verified against Marko's own server render: the emitted HTML is
byte-identical with and without the construct.

| Construct | Why it emits nothing |
|---|---|
| `<effect>` | Runs after render, on the client. |
| `<lifecycle>` | Client-side lifecycle hook. |
| `<script>` (the core tag) | Client behaviour, not markup. `<html-script>` emits a literal `<script>` element. |
| `<id>` | Allocates an identifier for the reactive runtime. |
| `<log>`, `<debug>` | Write to the console / attach a debugger hook. |
| `client` blocks | Evaluated only on the client. |
| `by=` on `<for>` | Reconciler input: which item a DOM node belongs to across re-renders. A one-shot render performs no reconciliation. |
| `key=` | Rejected by Marko's own parser before the translator sees it (`key is not a valid attribute, did you mean <for by>?`), so it needs no row of our own. |

### Evaluate initial value

| Construct | Lowering |
|---|---|
| `<let/x=expr/>` | `const x = expr` — reactive state has an initial value, and a one-shot render has no update path. Marko's own server render emits that value. |
| `<const/x=expr/>` | `const x = expr` |
| `attr:=expr` | The initial value renders; there is no write-back path. |
| `<define>`, `static`, `import`, `export interface Input` | Bound / hoisted to module scope. |

### Lowered — everything with output bytes

Elements, text, `${}` (escaped) and `$!{}` (raw), attributes including spread
and the `class`/`style` object and array forms, `.class#id` shorthand,
`<if>`/`<else if>`/`<else>`, every `<for>` form, `<html-comment>`, doctype,
`<style>`/`<html-script>`/`<html-style>` blocks, dynamic tags `<${expr}/>`,
components resolved by taglib and `tags/` discovery, and attribute tags.

Plain `<!-- -->` comments are **stripped**, because Marko strips them.

### Error — the target genuinely cannot

| Construct | Why |
|---|---|
| `<await>` | Suspends on a promise. This target is a synchronous `(input) => string`. Marko itself refuses to render one to a string: *"Cannot consume asynchronous render with 'toString'"*. |
| `<try>` with `<@placeholder>` | Needs a second render pass over suspended content, with nowhere to schedule it. A `<try>` **without** a placeholder lowers to a plain `try`/`catch`, with `<@catch>` as the catch block. |
| `<let/input=…>`, `<const/input=…>` | Declares `input` at render scope, where the emitted `function (input: Input)` already binds it — the template's own input would become unreachable. Marko rejects the same thing: *"Duplicate declaration of `input`"*. A tag *param* (`<for|input|>`) is a nested scope and is fine; see below. |

### Not Marko syntax

Distinct from the table above. These are not constructs the target cannot
express — they are spellings **Marko itself does not have**, so there is no
behaviour to reproduce and no fixture to write (no `.marko` file using them
compiles at all).

| Construct | Marko's own answer |
|---|---|
| `class:foo` / `style:foo` | *"`class:active` is not a valid attribute, did you mean `class={ active: condition }`?"* — verified for every form: static, dynamic, alone, and beside a plain `class`. The translator errors with Marko's own fix-it rather than inventing a lowering for markup the target does not have. Use the object form, which **is** supported: `class={ active: condition }`. |

### Rejected by Marko's own parser, before this translator runs

Some constructs need no row of their own, because a `.marko` file containing
them never compiles far enough to reach a translator. Recorded so their
absence from the table above is not mistaken for silent tolerance:

- `key=` on an element — *"`key` is not a valid attribute, did you mean
  `<for by>`?"*
- `$!{…}` in an attribute value (`<div title=$!{x}>`) — a raw placeholder is
  not valid in attribute position; Marko raises a parse error there, and the
  same error surfaces through `compile()` as a Marko `CompileError` rather
  than a `TranslateError`.

## Attribute tags differ from `@markox/html`

Both packages compile Marko syntax to a string function, and they disagree here
on purpose. `@markox/html` implements MX's own `.mx` dialect (decision S3);
this package implements Marko's conventions.

| | `@markox/translator` (Marko) | `@markox/html` (MX's `.mx`) |
|---|---|---|
| `<@header>x</@header>` | a **renderable**, rendered `<${input.header}/>` | a callable prop, `input.header()` |
| repeated `<@item>` | an **array** of renderables | last one wins |
| ordinary children | `input.content` | `input.children` |
| component resolution | taglib + `tags/` discovery + imports | explicit `import` or `<define>` only |
| unknown lowercase tag | resolved by Marko's registry | error unless hyphenated |
| `<!-- -->` comment | stripped | preserved |

## Why third-party translators are hard to write correctly

Marko's parser fills in more of a node than any one lowering path reads, and
the fields it fills in are *not* in `body.body`. A translator that walks only
the body renders none of them — and reports nothing, because from the walker's
point of view there was nothing there.

That is not hypothetical. The `@markox/html` audit found eight such fields,
each silently dropped by a translator that looked correct and passed its
fixtures:

| Field | What a naive walk does | What it should do |
|---|---|---|
| `attributeTags` | drops the content of every `<@name>` | lower them, or name the tag and its parent |
| `body.params` | binds the body to a name the author never wrote | error, or lower |
| `arguments` | drops `<Row(x)/>`'s arguments; the call gets `undefined` | pass them |
| `var` | drops `<div/ref>` | error, or lower |
| `typeArguments` | drops `<Card<string>>` | error |
| `attributes` on a no-output tag | drops them | error |
| `modifier` | emits `class="x"` for `class:foo="x"` — **different markup**, not a drop | error: not Marko syntax, repeating Marko's own fix-it |
| `bound` | drops `value:=v` | lower the initial value |

The modifier row is the worst kind: the output is not missing, it is *wrong*,
and it looks fine. The `by=` case is how the whole class was found — a fixture
cited `by=`, passed, and proved nothing, because the emitter read four
attributes and discarded the fifth.

Both packages therefore run one shared guard (`rejectUnsupportedFields` in
`@markox/html/core`) rather than a check per emission path. Every caller
**declares** the fields it genuinely lowers; anything else present on the node
is an error naming it. Seven scattered copies would drift, and the next field
Marko adds would be dropped by whichever copy was forgotten.

Inert constructs are declared to the same guard rather than skipped, so
"accepted with no output" and "silently swallowed" cannot be confused. Each
inert row declares the **shape it is inert in** — the body and attributes its
own Marko tag definition allows — and anything else is an error naming the tag
and what was found:

```marko
<effect() { go() }><div>inside</div></effect>
```
> `` `<effect>` does not support body content; it emits nothing, so the body
> would be silently discarded ``

That matches Marko, which rejects the same template with *"The `<effect>` tag
does not support body content"*. `<script>` is the one inert tag that **does**
take a body — its definition declares a raw-text one — and it is declared that
way rather than special-cased.

## Fixtures

`fixtures-marko/<name>/` holds `input.marko`, `input.json` and
`expected.html`, plus any sibling component or `tags/` directory the fixture
needs. `expected.html` is what **real Marko** renders, generated by running the
Marko 6 toolchain, not written by hand.

`bun run oracle:marko` renders every fixture both ways and compares them
semantically (parse5, decoded content, resume markers stripped). The run fails
if the glob is empty, a fixture is missing one of its three files, or fewer
than 30 fixtures were processed — a gate must assert it did work, not merely
that nothing failed.

## Pins

`@marko/compiler` 5.42.5 exactly, matching the rest of the repo. The taglib in
`taglib/marko.json` declares the core tags' parse options (statement tags,
control flow, `openTagOnly`, raw-text bodies) so the compiler parses stock
Marko the same way it does for `marko/translator`; the HTML, SVG and MathML
element taglibs load on their own.
