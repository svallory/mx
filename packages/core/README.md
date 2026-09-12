# `@mxlang/core`

The Marko-node consumer every MX host is built on.

MX is a template language born from Marko: Marko's syntax, brought to wherever
JSX lives today (see `notes/mx-vision.md`). MX itself defines the markup and the
**structural** tags — `<if>` / `<else if>` / `<else>`, `<for>` in all its forms,
attribute tags, tag params, `<define>`, `<const>`, `static`, `import` — and each
**host** decides what state, reactivity and output mean. This package is the
half that is the same for every host: it consumes Marko's AST through
`@marko/compiler`, resolves the structural lowerings into an IR, and asks
`HostDeclarations` for everything host-specific.

It depends on `@marko/compiler` and nothing else.

## Core versus host

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, why |
| The field guard (`rejectUnsupportedFields`) and the inert-shape guard | Component-versus-element resolution, and what a component call emits |
| The IR and its `drive`/`emit` traversal | An `Emitter` for the target's output shape, attributes and component calls |
| The two front doors (`compileSource`, `parseFragment`) | Stateful tags (`<let>`, `<effect>`, `:=`), through the three hooks |
| `escape` | Its own integration: a Vite plugin, a Bun loader, a TypeScript plugin |

`@mxlang/html` is the first host (vanilla HTML strings); `@mxlang/astro`
(`.amx`, expression-shaped Astro syntax) and `@mxlang/solid` (SolidMX's
`.solid.mx` bridge, Solid JSX text) are the other two.

## The HostDeclarations contract

A host passes one `HostDeclarations` object. `Policy` remains a compatibility
alias of that type only. Every member is a resolve-time question:

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name dispositions: `inert` (accepted, no output, in a declared shape) or `error` (this target cannot express it). Decision 65: never "my code cannot". |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `claimsTag?(name, ctx)` | Whether the host owns a tag the structural core does not. |
| `resolveHostTag?(name, node, ctx)` | Records the host's decision in `HostTag.data` while the Marko node is available. |
| `rejectModifier?`, `rejectAttributeMethod?` | Replace generic attribute diagnostics with the host's own wording. |
| `rejectElementAttributeTags?`, `rejectComponentTag?`, `rejectUnknownTag?` | Replace generic tag-routing diagnostics with the host's own wording. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at *render* scope; not called for tag params, which open a nested scope. |
| `keepComments?` | Whether an HTML comment reaches the output. |

`DYNAMIC_TAG` is the sentinel name `claimsTag` receives for `<${expr}/>`;
match against the exported constant rather than retyping it.

## The three stateful-tag hooks (decision 70)

MX does not define `<let>`, `<effect>`, `<lifecycle>`, `<script>` or `:=` —
those are framework territory, and mean whatever the host says (decision 71).
The core gives a host exactly three capabilities, exercised through the
resolver tests:

**1. Tag handler — `claimsTag` + `resolveHostTag`.** The core offers every tag
it does not own to the declarations before component/element routing. A host's
`<signal/count=1/>` records its resolved form in `HostTag.data`; the emitter
consumes that data and never sees the Marko node.

**2. Hoist — `ctx.hoist(code)`.** Lifts a statement to the head of the
enclosing function: the render function, or the nearest `Define`. A
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
  step, and the cross-instance problem above. `@mxlang/html` used to reach
  for `@mxlang/parser` (the *SolidMX parser* package, a vendored `@babel/parser`
  fork) for exactly one `parse` call; dropping that is what leaves this package
  with a single dependency.

If a future `@marko/compiler` removes or reshapes that subpath, the blast radius
is `markoBabel()` — one function, four named values — and the failure is a
missing export at require time, not silent wrong output.

## The two front doors

**`compileSource(source, filename, declarations, host)`** — a whole file,
through `@marko/compiler`'s `config.translator` seam (ADR 0001). `host` is
required and carries its `emitIr` function plus the
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
SolidMX's own bridge (`packages/parser/src/mx/bridge.ts`) now calls this
front door for every MX region it finds — see `packages/hosts/solid/README.md`
for the bridge's own side of that hand-off. Documented limits:

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

## The IR, and what a host implements (decision 79)

The core **resolves** a Marko template into a small host-independent tree, and
a host **emits** from that tree. No host walks a Marko node.

```
Marko AST ──resolve()──▶ Ir ──drive(emitter)──▶ whatever the host emits
             ▲                                  (strings, JSX nodes, …)
             └─ HostDeclarations: the questions the resolver asks
```

`src/ir.ts` defines the kinds. Each one exists because a host has to emit it
differently, and each carries a `loc` (1-based line, 0-based column — the
shape `TranslateError` reports, which is what an editor squiggle needs):

| Kind | The Marko construct it comes from |
| --- | --- |
| `Text` | A literal run, already normalized by Marko's own `onText` (decision 33) |
| `Interpolation` | `${expr}` and `$!{expr}`; `escaped` is false for the raw form |
| `Element` | An HTML/SVG/MathML element, with `attrs`, `children` and a `void` flag |
| `Component` | A component call: target is an import binding, a `<define>`, or `<${expr}/>` |
| `IfChain` | `<if>` plus every `<else if>`/`<else>`, grouped; the trailing else has a null condition |
| `For` | All four `<for>` forms, normalized to `of` / `in` / `range` (with `inclusive` for `to=` vs `until=`, `step` on a `range` source, and `key` from `by=` for a host with reconciliation — a string-emitting host ignores both; Solid's `<Repeat>` uses `step`, its `<For keyed>` uses `key`) |
| `Define` | `<define/Name\|params\|>` |
| `Const` | `<const/name=expr/>` |
| `Static` | A `static` block, and any host statement block that hoists like one |
| `Import` | An `import` statement, with the binding names it introduces |
| `Export` | Any other top-level `export`, hoisted verbatim |
| `InputInterface` | `export interface Input`, lifted so a host can place it |
| `Hoisted` | A statement lifted by decision 70's `hoist` hook |
| `HostTag` | A tag the host claimed, with attrs/children/attribute tags/params/var resolved, plus its own opaque `data` |
| `DocumentType` | `<!doctype html>`, delimiters already stripped by Marko |
| `Comment` | A comment; `html` distinguishes `<!-- -->` from `//`, which only the source can tell apart |

An expression arrives as `Expr`: the printed `code` (already rewritten through
the binding registry, so an emitter stays dumb) plus the original `node`, for a
host that must inspect the shape — `class={a: true}` versus `class=someCall()`
is an `ObjectExpression` test, not a string test.

### Writing a host, in order

1. **Declare.** Supply a `HostDeclarations` (`src/declarations.ts`): the `tags`
   disposition table, `isElement`, `isComponent`, optionally `checkBinding`,
   `keepComments`, `claimsTag`, `resolveHostTag` and `rejectModifier`. Every
   member is a *question* — none of them can emit, because during resolve there
   is nothing to emit into.
2. **Claim what is yours.** `claimsTag(name)` says the host lowers a tag
   itself; `resolveHostTag(name, node, ctx)` then records its decision into the
   node's `data` slot while the Marko node is still in hand. An emitter that
   had to re-inspect `tag.node` would be walking Marko nodes again — the thing
   the IR exists to stop. This is also the seam decision 80's user-tag macros
   will need.
3. **Emit.** Implement `Emitter<Out>` (`src/emit.ts`), one method per kind, and
   let `drive()`/`emit()` walk the tree. Every method is required: an emitter
   that silently ignored a kind would drop authored content from a successful
   compile (the S8 class this codebase's guards exist to close), so a host that
   cannot express a construct throws from the method, naming it and its
   position.
4. **Wire it.** Pass the required `emitIr` in `HostOptions`; the core resolves
   and hands your emitter the `Ir`.

**The string worked example is `@mxlang/html`** (`src/emitter.ts`): the vanilla
HTML host, an `Emitter<string[]>` that accumulates `out +=` lines. It is the
one to read, because it reproduces its predecessor's output byte for byte —
including two details that look accidental and are not: literals merge across
node boundaries into a single `out +=`, and `$forN` names a loop temporary from
the emitted-line count rather than a loop counter. The expression-shaped
example is `@mxlang/astro`'s `.amx` emitter: an `Emitter<string>` producing
ternaries, `.map` expressions, `class:list` and Astro named slots.

Statement tags resolve into `Ir.imports`, `Ir.hoisted` and
`Ir.inputInterface`; each host places them in its own module shape. This is
also how `.amx` moves a template `static` statement into Astro frontmatter.

## Tests

```
bunx vitest run --root ../.. --project @mxlang/core
```

`src/resolve.test.ts` (one fixture per IR kind, positions, host hooks and error
cases), `src/emit.test.ts` (the exhaustive driver), `src/fragment.test.ts` (the
fragment door, non-zero bases and the error path), and `src/escape.test.ts`.
