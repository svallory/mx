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

`examples/astro-static` is a three-page Astro site built entirely from `.mx`
components: props, a default slot, a named slot, a `.marko` alias import, and
one component composed from another. Its e2e suite asserts the rendered HTML
and, separately, that both expected-to-fail builds fail for the right reason.

```
cd examples/astro-static
bun run build      # astro build -> dist/
bun run e2e        # headless Chromium over dist/, plus the two error builds
```
