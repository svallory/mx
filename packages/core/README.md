# `@markox/core`

The Marko-node consumer every MX host is built on.

MX is a template language born from Marko: Marko's syntax, brought to wherever
JSX lives today (see `notes/mx-vision.md`). MX itself defines the markup and the
**structural** tags — `<if>` / `<else if>` / `<else>`, `<for>` in all its forms,
attribute tags, tag params, `<define>`, `<const>`, `static`, `import` — and each
**host** decides what state, reactivity and output mean. This package is the
half that is the same for every host: it consumes Marko's AST through
`@marko/compiler`, applies the structural lowerings, and asks a `Policy` for
everything host-specific.

It depends on `@marko/compiler` and nothing else.

## Core versus host

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, why |
| The field guard (`rejectUnsupportedFields`) and the inert-shape guard | Component-versus-element resolution, and what a component call emits |
| The default string-emit model (see below) | Structured attribute values (`class`, `style`), attribute order, modifiers |
| The two front doors (`compileSource`, `parseFragment`) | Stateful tags (`<let>`, `<effect>`, `:=`), through the three hooks |
| `escape` | Its own integration: a Vite plugin, a Bun loader, a TypeScript plugin |

`@markox/translator` is the first host (vanilla HTML strings); SolidMX and
Astro follow.

## The Policy contract

A host passes one `Policy` object. Every member, one line each:

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name dispositions: `inert` (accepted, no output, in a declared shape) or `error` (this target cannot express it). Decision 65: never "my code cannot". |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `emitComponent(ctx, node, name)` | Emits the call to a component, with this host's props convention. |
| `emitSpecial?(ctx, node, name)` | **Hook 1, the tag handler.** Every tag the core does not own reaches this, by name; returning true claims it. Stateful tags live here. |
| `emitModifier?(ctx, attr)` | Handles or rejects `class:foo="x"`-style attribute modifiers. |
| `attrValue?(ctx, name, source)` | Rewrites a structured attribute value (`class`, `style`); undefined interpolates unchanged. |
| `emitBoundAttr?(ctx, attr)` | Lowers a `:=` two-way binding; true when consumed. |
| `orderAttrs?(tagName, attrs)` | Reorders an element's attributes, for a target that emits them in an order other than the author's. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at *render* scope; not called for tag params, which open a nested scope. |
| `keepComments?` | Whether an HTML comment reaches the output. |
| `escapeFrom` | The import specifier the emitted module's `escape` comes from. |

`DYNAMIC_TAG` is the sentinel name `emitSpecial` receives for `<${expr}/>`;
match against the exported constant rather than retyping it.

## The three stateful-tag hooks (decision 70)

MX does not define `<let>`, `<effect>`, `<lifecycle>`, `<script>` or `:=` —
those are framework territory, and mean whatever the host says (decision 71).
The core gives a host exactly three capabilities, and `src/hooks.test.ts`
exercises all three against a fake policy (no real host uses them yet):

**1. Tag handler — `policy.emitSpecial`.** The core dispatches every tag it has
no lowering of its own for to the policy, before deciding whether the name is a
component or an element. A host's `<signal/count=1/>` is implemented there.

**2. Hoist — `ctx.hoist(code)`.** Lifts a statement to the head of the
enclosing function: the render function, or the nearest `blockFunction`. A
declaration written inside an `<if>` lands before the branch, so a reference
after the branch still resolves:

```
<if=input.on>
  <signal/count=7/>
</if>
<p>${count}</p>
```

emits `const count = 7;` at the function head, above `if (input.on) {`. Inside
a `<define>` it stops at that define's own function, since the statement may
read the define's params.

**3. Binding registry — `ctx.bindings.register(name, rewrite)`.** Rewrites
identifier *references* to a name the host owns. Registering `count` with
`` ref => `${ref}()` `` makes `${count + 1}` emit `count() + 1` — a host whose
state is a getter needs exactly this. Precision limits, all deliberate and all
tested:

- Reference positions only: `obj.count` and `{ count: 1 }`'s key are untouched
  (Babel's own `isReferencedIdentifier` draws the line).
- **Declarations print through `declName()`, never `expr()`**, and a declaration
  *shadows* the host's binding for the scope it binds. `<const/count=count + 1/>`
  emits `const count = count() + 1` — the initializer is evaluated before the
  binding exists, so it is still the host's; every later `${count}` is the local.
  `<for|count| of=xs>` and `<define/Row|count|>` shadow their bodies and restore
  afterwards. Without this split, a declared name that collides with a registered
  one emitted `const count() = …`: invalid JS with no diagnostic. A host adding a
  construct that declares a name must use `declName` for it.
- Shadowing is respected. An identifier is rewritten only when it is *free* in
  the expression (`path.scope.getBinding(name)` finds nothing), because a free
  name is the one that refers to the template-level binding the host registered.
  A parameter, `const`/`let`, or catch-clause binding of the same name inside the
  expression shadows it: `xs.map(count => count)` is untouched, while
  `xs.map(x => x + count)` is rewritten. Both pinned by tests.
- The walk runs only when something is registered, so a host with no stateful
  tags pays nothing.

## Which Babel the core uses

Two places need a JS parser: `importBindings()` (an `import` statement's local
binding names, which decide whether a tag is a component call) and the binding
rewrite above (walk an expression, replace references, re-parse the host's
returned source text). Both use **`@marko/compiler/internal/babel`**, required
lazily inside `markoBabel()` in `src/core.ts`, for `parse`, `parseExpression`,
`traverse` and `types`.

It is a **subpath export of `@marko/compiler`**, declared in that package's own
`exports` map — reachable by design, not a deep `node_modules` path — but the
`internal/` segment says plainly that its *contents* are the compiler's business,
not a semver-stable API. Three reasons that is the right trade here rather than a
second Babel dependency:

- **The nodes already belong to that instance.** Marko parses with its own
  bundled Babel and registers `MarkoTag` and friends on it; `traverse` from any
  *other* `@babel/traverse` refuses a visitor for those types outright, because
  it snapshots `TYPES` at module load (measured in
  `notes/research/marko-seam-spikes.md` spike 2 — registering Marko's types on a
  second instance updates the mutable registries but not the derived `is*`,
  generator or traverse tables). Asking a second Babel to walk these nodes is
  not "safer", it is broken.
- **The version is pinned exactly.** `@marko/compiler` is `5.42.5` with no
  range, here and in every consumer (AGENTS.md "Exact-pin policy"), so the
  surface cannot shift under us without a deliberate bump — and a bump is the
  moment to re-check it, which is true of the AST shapes this package consumes
  from the same instance anyway.
- **The alternative is worse.** Adding `@babel/parser` + `@babel/traverse` as
  real dependencies buys a second copy of Babel, a second version to keep in
  step, and the cross-instance problem above. `@markox/translator` used to reach
  for `@markox/parser` (the *SolidMX parser* package, a vendored `@babel/parser`
  fork) for exactly one `parse` call; dropping that is what leaves this package
  with a single dependency.

If a future `@marko/compiler` removes or reshapes that subpath, the blast radius
is `markoBabel()` — one function, four named values — and the failure is a
missing export at require time, not silent wrong output.

## The two front doors

**`compileSource(source, filename, policy, host?)`** — a whole file, through
`@marko/compiler`'s `config.translator` seam (ADR 0001). `host` carries the
taglibs to register, the tag-discovery directories, and an optional `postEmit`
pass over the emitted module text. `createTranslator(host)` is exported
separately because the taglib lookup is keyed on the translator object, so a
caller that wants the lookup must hand the compiler the same object.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn })`** — a
Marko *substring* of a larger file, with every position shifted to the
enclosing file. The consumer is a host whose MX lives inside another language
(SolidMX's `.solid.mx`). This is the stopgap
`notes/research/marko-seam-spikes.md` spike 1 measured, not a fix: the fix is an
additive base-position parameter upstream, which MX still intends to send.
SolidMX's own bridge (`packages/mx-parser/src/mx/bridge.ts`) is untouched until
phase 4 switches it over. Documented limits:

- Marko's own nodes (`MarkoTag`, `MarkoAttribute`, …) carry **no** numeric
  `start`/`end` at all — only `loc.{line,column}`. Nothing to shift there.
- The Babel expression nodes nested inside them carry their offset at
  `loc.*.index`, not at `start`/`end`. Both shapes are shifted.
- Position objects are **shared** between nodes, so the walk dedupes them: a
  second shift would land at `base + base` (measured — raw index 16 with
  `baseOffset: 42` came out at 100 instead of 58).
- A thrown parse error's position lives on the exception, not in the tree; it
  is shifted separately and the same error rethrown.
- Marko never populates Babel's file-level `comments` array; `MarkoComment`
  nodes in the body shift like any other node.

## The emit model

The emitters here are the core's **default string-emit model**: an `out +=`
buffer, `blockFunction`'s `() => string` blocks, `VOID_TAGS`, `DYNAMIC_TAG`, and
the emitted module shape (the `escape` import, the author's hoisted module
scope, their `Input` interface, one default-exported render function).

That model is not hidden behind the policy, deliberately. A host that emits
strings (`@markox/translator` today, Astro next) reuses it as is, which is most
of why a second string host is nearly free. A JSX host (SolidMX, phase 4)
replaces the emit layer instead — it emits Babel nodes, not text, so pushing
`VOID_TAGS` and `out +=` behind policy members would buy nothing and cost every
string host an indirection. Redesigning the emitter for JSX is phase 4's job,
not a speculative abstraction today.

## Tests

```
bunx vitest run --root ../.. --project @markox/core
```

`src/hooks.test.ts` (the three hooks), `src/fragment.test.ts` (the fragment
door, non-zero bases and the error path) and `src/escape.test.ts`.
