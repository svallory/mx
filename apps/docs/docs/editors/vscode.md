---
title: "VS Code"
description: "Highlighting, formatting, and diagnostics for .mx files in VS Code."
---

# VS Code

There is no dedicated MX extension yet. Because MX 1.0 is a strict subset of Marko syntax, the official Marko tooling already works on `.mx` files once you tell VS Code to treat them as Marko.

## Highlighting

Install the official Marko extension, then map `.mx` to Marko. Give
`.solid.mx` its own `solidmx` language id so a generic LSP client can route it
to MX's diagnostics server:

```json
{
  "files.associations": {
    "*.mx": "marko",
    "*.solid.mx": "solidmx"
  }
}
```

## Formatting

Format `.mx` files with `prettier-plugin-marko`'s Marko parser:

```json
{
  "overrides": [
    { "files": "*.mx", "options": { "parser": "marko" } }
  ]
}
```

This needs `prettier` and `prettier-plugin-marko` installed in your project.

## Diagnostics

No bundled VS Code extension launches `@mxlang/language-server` yet. Wire it up with a generic LSP client extension, or a minimal client of your own.

A generic LSP client extension (for example, one that reads a JSON server definition) typically wants something like:

```json
{
  "command": "bunx",
  "args": ["@mxlang/language-server", "--stdio"],
  "filetypes": ["marko", "mx", "solidmx"]
}
```

Or, from a small extension's own activation code:

```typescript
import { LanguageClient } from "vscode-languageclient/node";

const client = new LanguageClient(
  "mxlang",
  "MX diagnostics",
  { command: "bunx", args: ["@mxlang/language-server", "--stdio"] },
  {
    documentSelector: [
      { scheme: "file", language: "marko" },
      { scheme: "file", language: "solidmx" },
    ],
  },
);
client.start();
```

This runs alongside Marko's own language server, not in place of it — see [Language server](/editors/language-server/) for what it adds.

## TypeScript

Diagnostics above come from `@mxlang/language-server`, which checks MX
constructs against a host policy. TypeScript errors *inside* a `.solid.mx`
file — a wrong argument type in an attribute expression, a misspelled prop on a
component imported from one — are a separate job, handled by
`@mxlang/typescript-plugin` inside tsserver.

Add it to the project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

VS Code honours this for the workspace TypeScript version. To load the plugin
regardless of which version is selected, point at it explicitly:

```json
{
  "typescript.tsserver.pluginPaths": ["./node_modules/@mxlang/typescript-plugin"]
}
```

A dedicated MX extension would contribute the plugin from its own
`package.json` instead, which needs no user setting at all:

```json
{
  "contributes": {
    "typescriptServerPlugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

No such extension ships yet.

Do **not** also add an ambient `declare module "*.solid.mx"` shim. It replaces
each file's real exported types with whatever the shim asserts, which is
exactly what the plugin exists to stop.

`tsc` ignores `compilerOptions.plugins`, so a command-line typecheck needs
[`mx-tsc`](/editors/typescript/) rather than `tsc`.
