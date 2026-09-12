# @mxlang/solid

The Solid host: SolidMX's emitter over `@mxlang/core`'s shared IR (decisions
69, 71, 72, 79, 81). Same package shape as `@mxlang/astro` — `src/`,
`moon.yml`, a vitest project, this README — and the third emitter over the
core IR after `@mxlang/html` (vanilla strings) and `@mxlang/astro` (`.amx`).

## Install

```
bun add @mxlang/solid
```

Workspace-internal today: `@mxlang/parser` depends on it directly for the
`.solid.mx` bridge (see below), and no other package or example imports it.
Pinned dependencies: `@babel/generator`/`@babel/parser` at `7.29.8` (matching
the parser package's own pins), `@marko/compiler` at `5.42.5`, `magic-string`
at `0.30.21`. Solid 2 itself (`solid-js`, `@solidjs/web`, …) is **not** a
dependency of this package — it emits Solid JSX *text*, and never imports or
runs Solid's runtime.

## `.solid.mx` bridge

A `.solid.mx` file is a TypeScript module in which `<` in expression position
opens an MX region. `@mxlang/parser` (its vendored Babel fork) is the only
thing that finds these regions — `walk.ts`/`bridge.ts`, unchanged in scope by
this package. For each region, `packages/parser/src/mx/bridge.ts` slices the
raw region text and calls this package's `compileSolidMx(source, { filename,
baseOffset, baseLine, baseColumn })`, which runs `@mxlang/core`'s
`parseFragment` (Marko's parser, over just that substring, with every
position shifted by the given base), resolves the Marko AST into the core
IR under `solidDeclarations`, and emits Solid JSX text with `SolidEmitter`.
The result is re-parsed with Babel's own TSX expression parser and spliced
back into the surrounding TypeScript AST at the exact span the MX region
occupied, so diagnostics and the eventual source map stay anchored to
`.solid.mx` line/column positions rather than to the JSX text handed back —
covered by `reports a host/expression parse error past the enclosing region
base` in `src/index.test.ts`.

## Lowering table (IR kind → Solid JSX)

| IR kind / construct | Solid JSX |
|---|---|
| `Text` / `Interpolation` (escaped) | Literal text / `{expr}` |
| `Interpolation` (raw, `$!{...}`) | Must be the element or component's sole child; lowers to an `innerHTML={expr}` attribute, not to output text |
| `Element` (HTML/SVG/MathML) | A JSX element; `void` elements self-close |
| `Component` | A JSX element with attribute tags as render props (`name={body}` / `name={(...p) => body}`) and tag params as the child callback (`{(input) => ...}`) |
| `.cls` / `#id` shorthand | Folds into a plain `class="…"` / `id="…"` attribute; an object-valued `class={...}` alongside `.cls` merges to `class={["cls", {...}]}` |
| `prop:` namespace | Kept as `prop:name={value}` |
| `on:` / `oncapture:` / `attr:` / `bool:` / `use:` namespaces | Rejected, each with Solid 2's own replacement in the message (`on:x=fn` → `onX=fn`; `oncapture:` → a `ref` callback with `{ capture: true }`; `attr:`/`bool:` → the plain attribute; `use:foo=opts` → `ref=foo(opts)`) |
| `IfChain`, 1–2 conditioned branches | `<Show when={cond} fallback={...}>` |
| `IfChain`, 3+ conditioned branches | `<Switch fallback={...}><Match when={cond}>...</Match></Switch>` |
| `For`, `of=` | `<For each={list} keyed={...}>{(item, i) => body}</For>`; `keyed={false}` with no `by=`, `keyed={x => x.field}` for a string `by=`, the raw expression otherwise |
| `For`, `in=` | `<For each={Object.entries(obj)} keyed={e => e[0]}>{([k, v]) => body}</For>` |
| `For`, `range` (`from`/`to`/`until`, no `step`) | `<Repeat count={N} from={from}>{(i) => body}</Repeat>`, `N` folded at compile time when both bounds are literal |
| `For`, `range` with `step` | `<Repeat count={N}>{(mxIndex) => { const i = (from) + mxIndex * (step); return body; }}</Repeat>`; `N` clamped through `Number.isFinite(...) ? Math.max(0, ...) : 0` when not fully literal, so a runtime `step` of `0` renders zero rows instead of an infinite `Repeat` |
| `HostTag` `<try>` | `<Loading fallback={<@placeholder>}>children</Loading>`, wrapped in `<Errored fallback={(err, ...) => <@catch body>}>` when `<@catch>` is present |
| `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `:=` (bound attribute) | Errors: each names the Marko construct and points at Solid's own primitive (`createSignal`, `createEffect`, lifecycle primitives, "surrounding TypeScript module", an explicit event handler) — decision 69, these are framework territory and this host has no reactive lowering for them |
| Dynamic tag name (`<${expr}/>`) | Error: `dynamic tag name` |
| `<define>`, `<const>`, `Hoisted`, `DocumentType` inside a JSX expression | Errors: these must be declared in the surrounding TypeScript module, which is not this emitter's territory (a `.solid.mx` file is already a TS module — that's where they belong) |

Every emitted lowering row above has one test in
`src/index.test.ts`'s `Solid IR lowering` block, and every rejection above
one in its `Solid host errors` block, alongside the `<try>` shape errors
(tag params/var/arguments/attributes on `<try>` itself, an attribute tag
other than `<@catch>`/`<@placeholder>`, a duplicate `<@catch>`, tag params
on `<@placeholder>`) and `#id`/`.class` shorthand-merge errors.

## What is not in this package

Per decision 79, nothing Solid-specific lives in `@mxlang/core` beyond the
IR fields every Marko-syntax host needs to carry regardless of target
(`ForSource.range.step`, `For.key`) — `Show`/`Switch`/`Repeat`, the JSX
shape, and every lowering row above are this package's own. `rg -n
'lowerIfChain|lowerFor|lowerElement|lowerDynamicAttr' packages` and `rg -n
'solid|Show|Switch|Repeat' packages/core/src` should each return only hits
in this package (or nothing).

## Tests

```
bunx vitest run --root ../../.. --project @mxlang/solid
```
