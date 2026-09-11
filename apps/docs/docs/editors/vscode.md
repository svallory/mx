---
title: "VS Code"
description: "Highlighting, formatting, and diagnostics for .mx files in VS Code."
---

# VS Code

There is no dedicated MX extension yet. Because MX 1.0 is a strict subset of Marko syntax, the official Marko tooling already works on `.mx` files once you tell VS Code to treat them as Marko.

## Highlighting

Install the official Marko extension, then map the `.mx` extension to it:

```json
{
  "files.associations": { "*.mx": "marko" }
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
  "filetypes": ["marko", "mx"]
}
```

Or, from a small extension's own activation code:

```typescript
import { LanguageClient } from "vscode-languageclient/node";

const client = new LanguageClient(
  "mxlang",
  "MX diagnostics",
  { command: "bunx", args: ["@mxlang/language-server", "--stdio"] },
  { documentSelector: [{ scheme: "file", language: "marko" }] },
);
client.start();
```

This runs alongside Marko's own language server, not in place of it — see [Language server](/editors/language-server/) for what it adds.
