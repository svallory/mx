---
title: "Language server"
description: "@mxlang/language-server: diagnostics-only, for what a host's policy rejects."
---

# Language server

`@mxlang/language-server` is a small, diagnostics-only LSP server for MX hosts.

## Scope: diagnostics only

It does exactly one thing: watch `.mx`/`.marko` documents, compile each one under its resolved host policy, and publish one diagnostic per compile error. No completion, no hover, no go-to-definition, no formatting, no semantic tokens — Marko's own language server already provides all of that, and this server is meant to run *alongside* it, not replace it. Running two language servers against one file type is an ordinary pattern in both VS Code and Zed (the same way ESLint and TypeScript's own server coexist).

## Why it exists

Marko's own language server compiles with a fixed configuration that carries no host policy. A construct like `<let>` is valid Marko syntax, so Marko's server reports nothing for it — even in a project whose host forbids `<let>` under a `strict` policy. This server closes that gap: it knows which host and which policy apply to a given file, and flags what that policy rejects.

## Policy resolution

An editor only hands the server a file path and its text — nothing about which host compiles it. The server resolves that by walking upward from the file to the nearest `package.json`:

1. **An explicit `mxlang` field**, if present — the authoritative source:

   ```json
   { "mxlang": { "host": "translator", "strict": true } }
   ```

2. Otherwise, if that `package.json` depends on exactly one `@mxlang/*` host package, that host's default (non-strict) policy applies.
3. Otherwise, it falls back to the HTML host's default policy.

The Astro host always compiles under its strict policy — it has no non-strict mode — so `"host": "astro"` behaves as strict regardless of the field's own `strict` value.

## Running it directly

```bash
bunx @mxlang/language-server --stdio
# or
node node_modules/@mxlang/language-server/dist/bin.js --stdio
```

`--stdio` is accepted for symmetry with other language servers, but stdio is the only transport this server speaks.
