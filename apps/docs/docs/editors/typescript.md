---
title: "TypeScript"
description: "Type-check .solid.mx files in editors and in CI."
---

# TypeScript

A `.solid.mx` file is a TypeScript module whose MX regions lower to Solid JSX.
TypeScript itself knows none of that: it cannot parse the file, so without help
an editor shows nothing inside one, and an `import` of one is an unresolved
module.

Two packages fix that, sharing a single lowering so an editor and a build can
never disagree about whether a file compiles:

| | Package | Where it runs |
| --- | --- | --- |
| Editors | `@mxlang/typescript-plugin` | inside tsserver |
| CI | `@mxlang/tsc` (`mx-tsc`) | on the command line |

Both project each `.solid.mx` file to its lowered TSX and type-check that,
mapping every diagnostic back to the original file — at the exact column, not
the start of the region:

```tsx
export const el = <button onClick() { setCount(count() + "x") }>x</button>;
//                                             ~~~~~~~~~~~~~
// TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

## In an editor

Add the plugin to the project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

Editor-specific wiring — Zed's `vtsls` `globalPlugins` entry, VS Code's
`typescript.tsserver.pluginPaths` — is on the [Zed](/editors/zed/) and
[VS Code](/editors/vscode/) pages.

Once it is loaded, an import from ordinary `.ts`/`.tsx` code is typed from the
file's real exports:

```tsx
import { Counter } from "./Counter.solid.mx";

export const bad = <Counter nope={1} />;
// TS2322: Property 'nope' does not exist on type 'IntrinsicAttributes'.
```

Do **not** also write an ambient `declare module "*.solid.mx"` shim. A shim
asserts types rather than deriving them, so it hides the real signature and
every error the plugin would have found. If a project has one from before, delete
it.

## In CI

`tsc` ignores `compilerOptions.plugins`, so it cannot load the plugin: a
command-line typecheck would silently miss what the editor reports. Use
`mx-tsc`, which is `tsc` with the same language plugin spliced in, and takes
`tsc`'s own arguments, output and exit codes:

```json
{ "scripts": { "typecheck": "mx-tsc --noEmit" } }
```

The difference is total rather than partial — plain `tsc` never opens a
`.solid.mx` file at all:

```
$ mx-tsc --noEmit -p .
src/Widget.solid.mx(7,32): error TS2345: Argument of type 'string' is not
  assignable to parameter of type 'number'.

$ tsc --noEmit -p .
src/index.ts(1,23): error TS2307: Cannot find module './Widget.solid.mx' or
  its corresponding type declarations.
```

## Relationship to the language server

They do not overlap. [`@mxlang/language-server`](/editors/language-server/)
checks *MX constructs* against a host policy — a `<let>` tag where the host has
no reactive target, for example — and reports nothing about TypeScript. These
two check *TypeScript* and report nothing about host policy. Run both: an
editor can register several servers and several tsserver plugins against one
file kind, which is how ESLint and TypeScript already coexist.
