---
title: "Hono host"
description: "Compile .mx templates to Hono JSX component modules on the shared JSX emitter."
---

# Hono host

`@mxlang/hono` compiles a `.mx` or `.marko` template to a Hono JSX component
module. Structural MX becomes ordinary `hono/jsx` TSX: `<if>` becomes a
ternary, `<for>` becomes `.map()` with a `key`, component children are JSX
children, and attribute tags become props.

## Setup

```jsonc
{
  "dependencies": {
    "@mxlang/hono": "*",
    "hono": "4.6.20"
  },
  "mxlang": { "host": "hono" }
}
```

For a plain Bun server with no bundler, preload the Bun loader:

```toml
# bunfig.toml
preload = ["@mxlang/hono/bun"]
```

```ts
import { Hono } from "hono";
import App from "./App.mx";

const app = new Hono();
app.get("/", async (c) => c.html(await App({}).toString()));
```

The same host policy drives Vite, editor diagnostics, and `mx-tsc`. See
`examples/hono-app` for the complete app.

## Hono-specific output

The host emits `/** @jsxImportSource hono/jsx */` and keeps `class`/`for`
native — Hono, like Preact, accepts them directly with no renaming. It uses
`dangerouslySetInnerHTML={{ __html: value }}` for a sole raw placeholder.
Structured class objects and arrays go through `mxClass` so they remain Marko
class semantics instead of rendering as `[object Object]`.

Hono shares the same structural emitter as Preact and React. `@mxlang/hono`
depends on `@mxlang/preact` and supplies a Hono target object containing only
the names that differ. Unlike Preact and React, it ships **no hand-rolled
error boundary or suspense component** — Hono's `hono/jsx` provides
`ErrorBoundary` and `Suspense` natively, so this host's runtime supplies only
`mxClass`.

## Hooks and boundaries

```marko
import { useState } from "hono/jsx";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

`<const>` is emitted in the component body, where hooks belong. `static` is
module scope and must not call hooks. Marko's stateful tags are errors naming
Hono equivalents (`useState`, `useEffect`, `useId`).

`<try>` lowers to `hono/jsx`'s own `ErrorBoundary`, imported directly — its
fallback prop is `fallbackRender`, a function of the error, unlike Preact's/
React's `fallback` (which also accepts a bare node); `<@placeholder>` uses
`hono/jsx`'s own `Suspense`. Neither is wrapped by this package.

## No client hydration by default

`hono/jsx`'s server render (`String(jsx(Component, input))`, or Hono's own
`c.html(...)`) produces plain HTML with no resume markers, island wrappers, or
hydration bootstrap script. `examples/hono-app`'s e2e suite asserts the
response contains no `<script>` tag at all.

## Verification

`bun run oracle:hono` renders the 43 stock fixtures through `hono/jsx`: **30
pass, 13 reasoned skips, 0 bugs** — identical to `oracle:preact` and
`oracle:react`. `examples/hono-app` adds the server proof: Playwright fetches
a live Hono server rendering a `<for>` list and two `<try>` blocks, one of
which the built-in `ErrorBoundary` catches.
