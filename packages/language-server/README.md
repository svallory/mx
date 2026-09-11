# @mxlang/language-server

A small, diagnostics-only LSP server for MX hosts (decision 71/72).

## What it does

Watches `.mx`/`.marko` documents an editor opens or edits, runs
`@mxlang/core`'s `compileSource` under the file's resolved host policy, and
publishes one LSP `Diagnostic` per thrown `TranslateError` — the errors a
strict host policy raises for a construct it forbids (`<let>`, `<effect>`,
`<lifecycle>`, `<script>`, `:=` under `strictPolicy`). A successful compile
clears any previous diagnostics for that file.

## What it does not do

**Everything else.** No completion, no hover, no go-to-definition, no
formatting, no semantic tokens — Marko's own language server
(`marko-js/language-server`) already provides all of that for `.marko`/`.mx`
files, and this server is designed to run *alongside* it, not replace it
(`notes/research/host-diagnostics.md` §2: both VS Code and Zed support
multiple language servers registered against one language).

The reason a second server exists at all: Marko's own server compiles with a
hardcoded config that carries no host policy (`host-diagnostics.md` §1), so
`<let>` — valid Marko syntax — is invisible to it even when a host's
`strictPolicy` forbids it. `tsserver` can't fill the gap either: it never
opens `.marko`/`.mx` files in the first place (`host-diagnostics.md` §4).

## Why decisions 71/72 require this

> "A host is not done without its editor diagnostics" — a host that defines
> its own subset of MX (a `strict` policy, a stateful-tag disposition table)
> owes its authors in-file squiggles for the tags it rejects, not just a
> build-time error.

## Policy resolution

An editor hands the server a file path and text — nothing about which host
compiles it, or whether that host runs a `strict` policy. The server resolves
this by walking upward from the file, looking for the nearest `package.json`:

1. **`package.json#mxlang`**, if present: `{ "host": "translator" | "astro" |
   "solid", "strict"?: boolean }`. This is the authoritative source, and
   doubles as the routing config `@mxlang/vite-plugin`/the Bun loader already
   need for a mixed project (decision 71's "mixed projects" case).
2. Otherwise, if that `package.json` depends on **exactly one** `@mxlang/*`
   host package (`@mxlang/translator`, `@mxlang/astro`), use that host at its
   default (non-strict) policy.
3. Otherwise, fall back to the translator's default (non-strict) policy.

`@mxlang/astro` always compiles under `strictPolicy` (it ships no stateful
tags), so an `#mxlang` field naming `"host": "astro"` implies `strict: true`
regardless of what the field itself says — the server takes whatever `strict`
value the field states, matching the astro host's own fixed behavior in
practice. SolidMX (`"host": "solid"`) is paused (decision 58) and has no
`@mxlang/core`-based `Policy` object yet; until it does, files routed there
fall back to the translator's policy rather than throwing, so the rest of a
mixed workspace keeps getting diagnostics.

See `src/resolve-policy.ts` for the implementation and
`src/resolve-policy.test.ts` for all three branches.

## Debounce

150ms per document from the last `didOpen`/`didChange`/`didSave`; a
superseded run is cancelled (its timer cleared) rather than raced.

## Editors

### Zed

No zero-Rust path exists for registering a second language server against a
language another extension owns (or one's own): Zed's `extension.toml`
`[language_servers.<key>]` table binds a server only to a `languages` array
implemented by that extension's own `zed::Extension::language_server_command`
— a Rust `Cargo.toml`-backed extension, confirmed by reading
`marko-js/zed`'s own `src/lib.rs` (which does exactly this for
`@marko/language-server`, spawning it over stdio via `node`). This repo's
`packages/zed-extension` is currently grammar-only (no `Cargo.toml`,
`AGENTS.md` "No Rust") specifically because no `[language_servers.*]` entry
existed to need one. See `packages/zed-extension/UPSTREAM.md` and
`extension.toml` for the registration this package adds.

Both VS Code and Zed do support **multiple** servers on one language id —
this is not a workaround, it's how ESLint+TS or Tailwind+CSS coexist today
(`host-diagnostics.md` §2) — so adding this server does not replace Marko's.

### VS Code

No bundled extension ships from this package (out of scope for this task). A
generic LSP client extension (e.g.
[`vscode-generic-lsp`](https://marketplace.visualstudio.com/items?itemName=Gerrnperl.custom-lsp-client),
or a minimal `LanguageClient` of your own) can launch it directly:

```json
{
  "command": "bunx",
  "args": ["@mxlang/language-server", "--stdio"],
  "filetypes": ["marko", "mx"]
}
```

or, from a small extension's own `activate()`:

```ts
import { LanguageClient } from "vscode-languageclient/node";

const client = new LanguageClient(
  "mxlang",
  "MX diagnostics",
  { command: "bunx", args: ["@mxlang/language-server", "--stdio"] },
  { documentSelector: [{ scheme: "file", language: "marko" }] },
);
client.start();
```

### Any editor

The server works with both `bun` and `node`:

```
bunx @mxlang/language-server --stdio
# or
node node_modules/@mxlang/language-server/dist/bin.js --stdio
```

`--stdio` is accepted for symmetry with Marko's own server but not otherwise
inspected: `vscode-languageserver`'s `createConnection` auto-detects the
stdio transport when no other transport flag is given.

## Extension point: adding a host

`resolve-policy.ts`'s `HOST_PACKAGES` map and `diagnose.ts`'s
`resolvePolicyObject` are the two places a new host's `Policy` object gets
wired in. Today only `"translator"` resolves to a real, importable `Policy`
(`@mxlang/translator`'s `policy`/`strictPolicy`); `"astro"` reuses the
translator's `strictPolicy` (its own fixed behavior) rather than importing a
policy from `@mxlang/astro`, since that package does not export one
separately; `"solid"` is a documented placeholder for when SolidMX resumes.

## Tests

```
bunx vitest run --root ../.. --project @mxlang/language-server
```

`src/diagnose.test.ts` — `diagnoseDocument` directly: `<let>` under strict,
a valid file, `<let>` rendered under the non-strict policy, and the
unexpected-exception path (never throws, publishes nothing, calls the
caller's error callback). `src/resolve-policy.test.ts` — all three
policy-resolution branches, with fixture directories under `src/fixtures/`.
`src/server.test.ts` — the stdio end-to-end test: spawns the real built
`dist/bin.js`, exchanges `initialize`/`didOpen`, and asserts the
`publishDiagnostics` notification. Requires `bun run build` to have run
first (see the root `AGENTS.md` "Running tests in a fresh worktree" — `bun
run verify` builds before it tests, so this only matters when running this
package's tests standalone).
