---
title: "HTML host"
description: "Compile .mx and .marko templates to a plain (input) => string function, no runtime beyond an escape helper."
---

# HTML host

The HTML host — currently published as `@mxlang/html` (soon `@mxlang/html`) — is the vanilla MX host. It compiles an `.mx` file (or its `.marko` alias) to a pure function: a JS/TS module whose default export is `(input) => string`, with no runtime beyond an `escape` helper. No scheduler, no signals, no hydration, no resume markers.

The generic half of the work — consuming Marko's AST, applying the structural lowerings, the string-emit model — lives in the shared core. This host supplies the policy on top of it: which tags are inert and which are compile errors, component-versus-element resolution, structured `class`/`style` values, and its own integrations (a Bun loader, the `escape` runtime, a taglib).

Because MX 1.0 is a strict subset of Marko syntax, this host compiles **stock Marko**, not a dialect: tag discovery through taglibs and `tags/` directories, Marko's own HTML/SVG/MathML element registry, Marko's attribute-tag and component conventions. A template written for Marko compiles here unchanged and renders the same bytes Marko's own server render produces.

```html
<!-- greeting.mx -->
<h1 class={greeting: true}>Hello, ${input.name}!</h1>
```

compiles to:

```typescript
import { escape } from "@mxlang/html";

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

## Install

```bash
bun add @mxlang/html
```

## API

```typescript
import { compile } from "@mxlang/html";

const { code } = compile(source, "greeting.mx");
```

- `compile(source, filename, { strict? })` → `{ code, map }`
- `compileFile(filename, { strict? })` → `{ code, map }`
- `build(filenames, { strict? })` → `Map<filename, { code, map }>`, a CLI-free build step
- `escape(value)` — the entire runtime the emitted module imports
- `TranslateError` — thrown for a construct with no lowering, carrying `line`/`column`

The package is also a plain `@marko/compiler` translator, so the compiler's own entry points work directly:

```typescript
import { compileSync } from "@marko/compiler";
import translator from "@mxlang/html";

compileSync(source, filename, { translator, output: "html" });
```

## Loaders

Two loaders make `import page from "./page.mx"` (or `"./page.marko"`) resolve, one per runtime.

**Bun** — `@mxlang/html/bun` is a plugin that intercepts `.mx` and `.marko` imports and compiles them on the fly (`.solid.mx` is excluded; that is a different file kind handled separately). Register it once:

```toml
# bunfig.toml
preload = ["@mxlang/html/bun"]
```

or at runtime:

```typescript
import markoPlugin from "@mxlang/html/bun";
Bun.plugin(markoPlugin);
```

**Vite** — `@mxlang/vite-plugin`'s `mx()` plugin handles `.mx` and `.marko` alongside `.solid.mx` by default:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import mx from "@mxlang/vite-plugin";

export default defineConfig({
  plugins: [mx()],
});
```

`import page from "./x.mx"` typechecks against ambient declarations (`declare module "*.mx"`, typed `(input: any) => string`); add the file to your `tsconfig.json` `include` to pick them up.

## Consumer usage

```typescript
import render from "./greeting.mx";

const html = render({ name: "World" });
// '<h1 class="greeting">Hello, World!</h1>'
```

## Strict mode

By default this host renders what Marko's own server render would emit for the stateful tags (`<let>`'s initial value, `<effect>`/`<lifecycle>`/`<script>`/`client` blocks/`<id>` as inert — contributing no output). Passing `{ strict: true }` switches to a stricter policy that rejects those same constructs as compile errors instead, for a template that has no business needing a reactive runtime:

```typescript
const { code } = compile(source, "greeting.mx", { strict: true });
```

`compileFile` and `build` take the same option. See [Stateful tags](/language/stateful-tags/) for the full policy table and what a host is free to decide for itself.
