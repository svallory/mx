# @mxlang/astro

MX (Markup eXtended) is a template language born from Marko: it takes Marko's
syntax and brings it to wherever JSX lives today, MX 1.0 being a strict subset
of Marko so every borrowed Marko tool keeps working by aliasing alone. `.mx` is
MX's official extension; `.marko` is accepted everywhere with identical
treatment, so porting a Marko component is a rename or nothing.

`@mxlang/astro` is **the Astro host**: it renders `.mx` components inside an
Astro project as static markup at build time. An MX component compiles to a
runtime-free `(input) => string` function ([`@mxlang/translator`](../translator/README.md)),
is called during Astro's build, and never reaches a browser. No islands, no
hydration, no client JS from this renderer.

## Install

```
bun add -d @mxlang/astro
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import mx from "@mxlang/astro";

export default defineConfig({
  integrations: [mx()],
});
```

That is the whole setup. The integration registers a renderer and adds MX's
existing Vite plugin (`@mxlang/vite-plugin`, unchanged — an Astro project is a
Vite project, and that plugin already turns a `.mx` file into a plain module).

```astro
---
import Card from "../components/card.mx";
---

<Card title="Hello">
  <p>Default slot content.</p>
  <Fragment slot="footer">Footer content.</Fragment>
</Card>
```

```mx
// card.mx
export interface Input {
  title: string;
  content: () => string;
  footer?: () => string;
}

<article class="card">
  <h2>${input.title}</h2>
  <div>$!{input.content()}</div>
  <if=input.footer>
    <footer>$!{input.footer()}</footer>
  </if>
</article>
```

## How slots map

Astro hands a renderer its slots as `Record<string, string>` of **already
rendered HTML**. MX's compiled modules take children and attribute tags as
`() => string` thunks. The mapping is therefore one line: each slot string is
wrapped in a thunk that returns it.

| Astro | MX |
| --- | --- |
| the default slot | the `content` prop (MX's name for ordinary children) |
| `<Fragment slot="footer">` | the `footer` prop — what `<@footer>` sets |
| a prop | a prop, unchanged |

Insert a slot with `$!{...}`, not `${...}`: the slot is markup Astro already
rendered, and `${...}` would escape it into visible angle brackets.

Two limits follow from slots being strings, both inherent to Astro's contract
rather than to MX:

- **Attribute-tag params get nothing.** A template writing `<@footer|year|>`
  compiles to a `footer: (year) => string` its caller invokes with an argument.
  A slot from Astro is already rendered, so the thunk ignores whatever it is
  handed. Astro has no channel for passing a value back into a slot, so this is
  documented rather than detected: the renderer receives a compiled function,
  not the template that declared the params.
- **Slot HTML is inserted verbatim.** Astro rendered it, so it is markup, not
  text to escape.

## What is and is not supported

**Supported**: MX's structural core — `<if>` / `<else if>` / `<else>`, every
`<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`,
`import` — props, slots, and one MX component calling another. `.marko` files
work identically to `.mx` ones.

**Not supported, by design**: the stateful tags. `<let>`, `<effect>`,
`<lifecycle>`, `<script>`, `client` blocks and `<id>` are **compile errors**
naming the construct. This host compiles MX under `@mxlang/translator`'s
`strictPolicy`: it renders once, at build time, with no reactive runtime
anywhere, so a construct that only means something with a runtime is a build
error rather than markup that silently renders once and never updates
(decision 71 — stateful tags mean whatever the host says).

**`client:*` directives** on an MX component **fail the build**, naming the
component:

```
`Card` is an MX component and renders statically: remove the `client:load`
directive. MX compiles to a plain function with no state and no runtime, so
there is nothing to hydrate on the client.
```

This host raises that itself. Astro ships an error for exactly this case
(`NoClientEntrypoint`: *"component has a `client:` directive, but no client
entrypoint was provided by RENDERER_NAME"*) but never throws it — measured
against `astro@7.3.2`, the only occurrences in the installed package are the
message definition in `dist/core/errors/errors-data.js` and its `.d.ts`, and
the render path is a bare `if (renderer.clientEntrypoint)`
(`dist/runtime/server/hydration.js:98`) with no else branch. Left to Astro, the
build would succeed and ship an `<astro-island client="load">` whose loader
falls back to a no-op hydrator: an island that silently does nothing, on a host
whose whole claim is shipping no client JS.

So `renderToStaticMarkup` throws when Astro's `metadata.hydrate` is set.
`examples/astro-static/e2e/build-errors.spec.ts` asserts the failing build.

## Pages

Decision 76b: an `.mx` file directly under `src/pages` is a **page**, not a
component. The integration calls Astro's `addPageExtension(".mx")`, so
`src/pages/about.mx` routes to `/about` the way `about.astro` would.
`.marko` is **not** registered as a page extension — it stays a
component-only alias, so a `.marko` file placed under `src/pages` is invisible
to Astro's router rather than half-page, half-component.

```mx
// src/pages/hello.mx
export const layout = "../layouts/Base.astro";
export const title = "Hello";

static const items = ["one", "two"];

<h1>${title}</h1>
<ul>
  <for|item, i| of=items>
    <li>${i}: ${item}</li>
  </for>
</ul>
```

**What `input` receives**: `{ ...props, params, url }` — the page's own
Astro props (from `getStaticPaths`'s `props`, or the parent route's props for
a nested page), plus `Astro.params` and `Astro.url` merged in under those
names. A dynamic route reads `input.params.slug` the same way a `.astro` page
reads `Astro.params.slug`.

**`layout`**: `export const layout = "../layouts/Base.astro";` in the page's
TypeScript section (a plain string literal; Marko allows a top-level
`export`, mirrored here for exactly this one purpose). When present, the
page's rendered HTML becomes the layout's default slot, and the layout
receives `{ frontmatter, url, params }` as props — `frontmatter` being every
other top-level `export const NAME = ...;` the page declares, mirroring
Markdown's own `layout` behaviour (`astro/dist/vite-plugin-markdown`: the
content becomes the layout's slot, frontmatter keys become
`Astro.props.frontmatter`). Without `layout`, the rendered HTML is used as-is
— the page writes its own `<html>` or composes through an ordinary MX
`content` prop.

**Named exports pass through.** `getStaticPaths`, `prerender`, and any other
top-level `export` in the page's TypeScript section reach Astro's router
unchanged — `@mxlang/core`'s `emitStatement` hoists any `export` (not only
`export interface Input`) to real module scope, so a dynamic route works the
same way it would in a `.astro` file:

```mx
// src/pages/posts/[slug].mx
export const getStaticPaths = () => [
  { params: { slug: "first" }, props: { title: "First post" } },
  { params: { slug: "second" }, props: { title: "Second post" } },
];

export const prerender = true;

<h1>${input.title}</h1>
```

**Strict policy applies here too.** A page compiles under the same
`strictPolicy` as components: `<let>` (and the rest of the stateful tags) in
a page is a build error naming the construct and the file, exactly as in a
component.

**Limits**: a page has no `Astro.slots` — nothing renders a page inside
another component's slot — and, like components, `client:*` on a page-mode
MX file fails the build for the same reason (nothing to hydrate).

## Typing `.mx` imports

Add the ambient declarations to your project's `src/env.d.ts`:

```ts
/// <reference types="astro/client" />
/// <reference types="@mxlang/astro/types" />
```

This types every `.mx` (and `.marko`) import as `(input: any) => string` —
one generic shape for every file, not each file's own `Input` interface.
Per-file typing needs a virtual-file projection of the compiled module inside
tsserver's language-service layer, which is the `astro-ts-plugin` task;
`@astrojs/ts-plugin` is not reusable for it, since it adds `.astro` imports
*within* `.ts` files — the opposite direction. An ambient `any` until the
language service exists follows decision 62's precedent.

## Example

`examples/astro-static` is an Astro site built from `.mx`: components (props,
a default slot, a named slot, a `.marko` alias import, one component composed
from another) and pages (a layout page with a `static`-block and
`<if>`/`<for>`, a page with no layout, and a dynamic `posts/[slug].mx` with
`getStaticPaths`). Its e2e suite asserts the rendered HTML for every page and,
separately, that both expected-to-fail builds fail for the right reason.

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run e2e        # headless Chromium over dist/, plus the two error builds
```
