---
title: "Preact host"
description: "The Preact host — a .mx template compiles to a Preact component module, with every structural tag lowered to plain JSX."
---

# Preact host

The Preact host compiles a `.mx` (or `.marko`) template to a **Preact component module**: JSX text carrying its own `@jsxImportSource` pragma, with the author's imports and `static` blocks at module scope and their `export interface Input` as the component's props type.

It ships as `@mxlang/preact` (`packages/hosts/preact`), the fourth emitter over `@mxlang/core`'s shared IR alongside the HTML, Astro and Solid hosts — and the first whose target has **no control-flow components at all**. Where Solid has `<Show>`/`<For>` and Astro has its own template syntax, Preact has plain JSX plus JavaScript, so every structural tag lowers to an *expression*: a ternary chain for `<if>`, a `.map` call for `<for>`, exactly what a Preact author would write by hand.

## Selecting the host

```jsonc
// package.json
{
  "dependencies": { "@mxlang/preact": "*", "preact": "10.29.8" },
  "mxlang": { "host": "preact" }
}
```

`mxlang.host` is read by `@mxlang/core`'s `resolveHostPolicy`, which the Vite plugin, the language server and `mx-tsc` all share — so an editor, a `tsc` run and a build cannot disagree about what a `.mx` file is. A project that depends on exactly one `@mxlang/*` host package gets that host without the field.

```ts
// vite.config.ts — mx() first: both plugins are `enforce: "pre"`.
export default defineConfig({ plugins: [mx(), preact()] });
```

## What it looks like

```marko
import { useState } from "preact/hooks";

export interface Input { label: string }

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>

<section>
  <h1>${input.label}</h1>
  <output>${count}</output>
  <button onClick() { setCount(count + 1); }>increment</button>
  <if=(count > 9)><p>double digits</p></if>
  <for|name| of=input.names by="id"><p>${name.text}</p></for>
</section>
```

Hooks go in `<const>`, which lowers to a statement in the **component body** where the rules of hooks hold. A `static` block hoists to module scope and runs once per module, so a hook there is a rules-of-hooks violation — a property of the target, which this host documents rather than detects.

## Two rules worth knowing

**Every `<for>` row gets a `key`.** A Preact list without one re-creates its rows on each render. `by="id"` names a field of the row; `by=fn` is a function of it; with no `by=` the key is the row's own identity — the item for `of`, the property name for `in`, the loop value for a range. That default is right for *unique* primitives and stable ranges. Two cases need `by=`, neither detectable at compile time: **duplicates** (`["a", "b", "a"]` keys two rows `"a"`, which Preact warns about and may reconcile wrongly — key by position with `by=(tag, index) => index`), and **objects** (identity changes whenever the array is rebuilt, remounting every row — key by a stable field with `by="id"`).

**Children cross the `content`/`children` gap.** Marko names a component's ordinary children `content`; JSX names the same slot `children`. The host emits calls the JSX way — so a hand-written Preact component can be called from MX — and the emitted component bridges the two names, so a template's own `${input.content}` still reads them.

## `<try>`

Preact has no built-in error boundary component, so this host ships one. `@mxlang/preact/runtime` exports `MxErrorBoundary` (a class component using `componentDidCatch`, the only form Preact gives that hook) for `<@catch>`, and `MxPlaceholder` (`preact/compat`'s `Suspense` under one name) for `<@placeholder>`. Both are ordinary Preact components with no MX-specific protocol. When a `<try>` has both, the placeholder nests inside the boundary, so a render error reaches the catch.

## What each construct lowers to

Every structural kind becomes a plain JSX expression — Preact has no
control-flow components, so there is nothing else for them to become.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML` |
| `class="a"` | `class="a"` (Preact takes `class` directly) |
| `class={a: cond}` | `class={mxClass({a: cond})}` |
| `style={color: c}` | `style={{color: c}}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `...rest` | `{...rest}` |
| `<if>` / `<else-if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => …)}` with a `key` |
| `<for\|v, k\| in=obj>` | `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1/>` | `<Comp x={1}/>` |
| `<Comp>children</Comp>` | children passed the JSX way |
| `<Comp\|item\|>` | a render-prop callback |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<const/x=expr/>` | a `const` in the component body |
| `<define/R\|p\|>` | a nested function component |
| `<try>` | `MxErrorBoundary` / `MxPlaceholder` |
| `import`, `static`, `export` | hoisted to module scope verbatim |

Element-versus-component follows **Marko's** rule, not JSX's: a tag resolves to
a component when a binding or taglib entry says so, whatever its case. A
`tags/`-discovered `<badge/>` is a component call, not a literal `<badge>`
element; the host binds it under a generated name in the emitted JSX.

## Errors

Marko's stateful tags are compile errors naming the Preact equivalent: `<let>` points at `useState`, `<effect>` at `useEffect`, `<lifecycle>` and `<script>` at the hooks that replace them, `<id>` at `useId`, `:=` at passing a value plus an explicit handler. A `client` block is an error too — this host's output *is* the client.

So is anything else this target cannot express — `<await>`, `<return>`, `<!doctype html>` (it belongs to the HTML shell that mounts the app), a dynamic tag name with a body (JSX requires a capitalized identifier in tag position), a raw `$!{…}` placeholder with siblings (the prop replaces the whole subtree), a non-object `style=`, and `class:active` (not Marko syntax — see [Errors](/language/errors/)). Nothing degrades silently.

## Verification

`bun run oracle:preact` compiles every fixture in the stock `.marko` set — the same 43 `oracle:marko` uses — renders it with `preact-render-to-string`, and compares against the fixture's own `expected.html`, which was generated from real Marko. **30 pass, 13 skipped (each naming the construct), 0 bugs.** `examples/preact-app` carries the end-to-end proof that the result is a *live* component: a real browser clicking a real button and seeing the count change.
