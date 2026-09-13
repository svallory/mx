# `@mxlang/react`

MX's React host compiles a `.mx` (or `.marko`) template to a React component
module: TSX with `/** @jsxImportSource react */`, the author's imports and
`static` blocks at module scope, and `export interface Input` as the component
props type.

## Why it shares the Preact emitter

React and Preact make the same structural lowering choices: `<if>` is a
ternary, `<for>` is `.map()` with a `key`, ordinary children are JSX children,
and attribute tags are props. `@mxlang/react` therefore depends on
`@mxlang/preact` and passes a React `Target` to its exported emitter instead of
forking it. The target owns only vocabulary: JSX import source, `className`,
`htmlFor`, raw-HTML prop, Fragment module, and runtime-helper module. Structural
changes remain one implementation and one test surface.

The React runtime is not shared with Preact and uses no compatibility layer.
`src/runtime.ts` imports React directly and implements `<try>` as a native
React class error boundary plus React's `Suspense`.

## Install

```jsonc
{
  "dependencies": {
    "@mxlang/react": "workspace:*",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "mxlang": { "host": "react" }
}
```

```ts
// vite.config.ts — MX must turn `.mx` into TSX before React handles it.
import react from "@vitejs/plugin-react";
import mx from "@mxlang/vite-plugin";

export default defineConfig({ plugins: [mx(), react()] });
```

The host field is shared by Vite, the language server, and `mx-tsc`. A project
with exactly one `@mxlang/*` host dependency may omit it.

## Lowering

| MX | React |
| --- | --- |
| text, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `class="a"` | `className="a"` |
| `class={a: cond}` | `className={mxClass({ a: cond })}` |
| `<label for="id">` | `<label htmlFor="id">` |
| `style={color: c}` | `style={{ color: c }}` |
| `onClick() { go(); }` | `onClick={() => { go(); }}` |
| `<if=c>` / `<else>` | a ternary chain |
| `<for\|x\| of=xs by="id">` | `[...xs].map(x => <Fragment key={x.id}>…</Fragment>)` |
| `<Comp>children</Comp>` | JSX children |
| `<Comp\|item\|>…</Comp>` | a render-prop child |
| `<@name>body</@name>` | a named prop; repeated tags become an array |
| `<const/x=expr/>` | `const x = expr` in the component body |
| `<define/Row\|p\|>` | a local arrow returning JSX |
| `<try>` | `MxErrorBoundary` and, with `<@placeholder>`, `MxPlaceholder` |

Every loop row gets a key. `by="id"` reads a row field; a function-valued
`by=` is called with the row and optional index. Without `by=`, the row's own
identity is used: item for `of`, property name for `in`, value for a range.
Lists of objects should normally use a stable field such as `by="id"`.

Marko calls ordinary component children `content`, while JSX calls them
`children`. Emitted calls use `children` so hand-written React components work;
the generated component bridges that value back to `input.content`.

## State and `<try>`

Use React hooks from a top-level `<const>`, which is emitted inside the
component function:

```marko
import { useState } from "react";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

Hooks in `static` are invalid because `static` is module scope. Marko's own
stateful tags are compile errors with React guidance: `<let>` points to
`useState`, `<effect>` to `useEffect`, and `<id>` to `useId`.

`@mxlang/react/runtime` exports:

- `MxErrorBoundary`, a React class component using
  `getDerivedStateFromError` and `componentDidCatch`;
- `MxPlaceholder`, React's `Suspense` under the emitter's stable name;
- `mxClass`, the structured-class string joiner.

These are ordinary React components, not an MX runtime. Templates that use no
`<try>` or structured class import no helper.

## Verification

```sh
bunx vitest run --root ../../.. --project @mxlang/react
bun run oracle:react
cd examples/react-app && bun run e2e
```

The oracle compiles all 43 stock Marko fixtures, renders through
`react-dom/server`'s `renderToStaticMarkup`, and compares with the HTML host
using semantic HTML normalization: **30 pass, 13 reasoned skips, 0 bugs**.
React 19 injects leading image preload hints during static rendering; the
oracle removes only those renderer-generated hints before comparing authored
markup.
