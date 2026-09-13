---
title: "React host"
description: "Compile .mx templates to native React component modules on the shared JSX emitter."
---

# React host

`@mxlang/react` compiles a `.mx` or `.marko` template to a React component
module. Structural MX becomes ordinary React TSX: `<if>` becomes a ternary,
`<for>` becomes `.map()` with a `key`, component children are JSX children,
and attribute tags become props.

## Setup

```jsonc
{
  "dependencies": {
    "@mxlang/react": "*",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "mxlang": { "host": "react" }
}
```

```ts
import react from "@vitejs/plugin-react";
import mx from "@mxlang/vite-plugin";

export default defineConfig({ plugins: [mx(), react()] });
```

The same host policy drives Vite, editor diagnostics, and `mx-tsc`. See
`examples/react-app` for the complete app.

## React-specific output

The host emits `/** @jsxImportSource react */`, maps `class` to `className` and
HTML `for` to `htmlFor`, keeps style objects, and uses
`dangerouslySetInnerHTML={{ __html: value }}` for a sole raw placeholder.
Structured class objects and arrays go through `mxClass` so they remain Marko
class semantics instead of rendering as `[object Object]`.

React and Preact share one structural emitter. `@mxlang/react` depends on
`@mxlang/preact` and supplies a React target object containing only the names
that differ. Its runtime is native React—not a Preact compatibility layer.

## Hooks and boundaries

```marko
import { useState } from "react";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

`<const>` is emitted in the component body, where hooks belong. `static` is
module scope and must not call hooks. Marko's stateful tags are errors naming
React equivalents (`useState`, `useEffect`, `useId`).

`<try>` lowers to `MxErrorBoundary`, a native React class component using
`componentDidCatch`; `<@placeholder>` uses React's `Suspense`. Both live in
`@mxlang/react/runtime`, alongside `mxClass`, and are imported only when used.

## Verification

`bun run oracle:react` renders the 43 stock fixtures with
`react-dom/server`'s `renderToStaticMarkup`: **30 pass, 13 reasoned skips, 0
bugs**. `examples/react-app` adds the browser proof: Chromium clicks a live
counter and observes a render error caught by `<try>`.
