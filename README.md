# MX

MX: Marko's syntax with pluggable host-language expressions. SolidMX (codename "Fluid"): the first target, MX in JSX's position inside Solid component files.

## Packages

| Package | npm name | Purpose |
|---|---|---|
| `packages/mx-parser` | `@mx/parser` | `@babel/parser` fork: MX in expression position -> lowered JSX AST (the language) |
| `packages/babel-plugin-mx` | `@mx/babel-plugin` | `parserOverride` -> mx-parser; injects runtime helper imports |
| `packages/mx-solid-runtime` | `@mx/solid-runtime` | `Key`, `mxRange`, `identity` (under 1 KB) |
| `packages/mx-typescript-plugin` | `@mx/typescript-plugin` | `@volar/typescript` plugin; virtual `.tsx` via `@babel/generator` source maps |
| `packages/mx-tsc` | `@mx/tsc` | `tsc` wrapper (`runTsc`) so CI type-checks `.solid.mx` |
| `packages/mx-vscode` | `@mx/vscode` | TextMate grammar + `typescriptServerPlugins` manifest |
| `packages/eslint-plugin-mx` | `@mx/eslint-plugin` | MX-specific lint rules (parser is `@babel/eslint-parser` + `babel-plugin-mx`) |
| `packages/vite-plugin-mx-solid` | `@mx/vite-plugin-solid` | Optional Vite config convenience wrapper |

**Naming TODO**: the `@mx/*` scope and these short names are placeholders. Final npm names are undecided (see `notes/index.md` in the space root, "Naming on npm").

## Pinned versions

All dependencies below are pinned to an exact version (no `^`/`~`) at the root `package.json`. Reason: `mx-parser`'s output must be byte-reproducible wire format between the parser, the Babel plugin, and the TS plugin's virtual-file generator — a transitive semver bump in Babel or the TS compiler could silently change AST shape or emitted output and break that guarantee without warning.

| Package | Version |
|---|---|
| `@babel/parser` | 7.29.8 |
| `@babel/core` | 7.29.7 |
| `@babel/generator` | 7.29.8 |
| `@babel/traverse` | 7.29.8 |
| `@babel/types` | 7.29.8 |
| `htmljs-parser` | 5.15.0 |
| `babel-preset-solid` | 1.9.15 |
| `solid-js` | 1.9.15 |
| `typescript` | 5.9.3 |
| `vitest` | 3.2.7 |
| `@biomejs/biome` | 2.5.12 |

Note: Babel 8 (8.0.x) and TypeScript 7 (7.0.x) were released but are new majors; the spec's parser fork targets Babel 7's `parserOverride`/JSX-plugin shape and TS's current plugin API, so this scaffold pins the latest stable Babel 7 / TypeScript 5 line instead.

## Scripts

Runnable via `bun run <name>` or `moon run :<name>`:

- `typecheck` — `tsc --noEmit` per package
- `test` — `vitest run`
- `lint` — `biome check .`
- `verify` — typecheck, then lint, then test; stops on first failure
