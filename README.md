# MX

MX: Marko's syntax with pluggable host-language expressions. SolidMX (codename "Fluid"): the first target, MX in JSX's position inside Solid component files.

## Packages

| Package | npm name | Purpose |
|---|---|---|
| `packages/mx-parser` | `@markox/parser` | `@babel/parser` fork: MX in expression position -> lowered JSX AST (the language) |
| `packages/babel-plugin-mx` | `@markox/babel-plugin` | `parserOverride` -> mx-parser |
| `packages/mx-typescript-plugin` | `@markox/typescript-plugin` | `@volar/typescript` plugin; virtual `.tsx` via `@babel/generator` source maps |
| `packages/mx-tsc` | `@markox/tsc` | `tsc` wrapper (`runTsc`) so CI type-checks `.solid.mx` |
| `packages/mx-vscode` | `@markox/vscode` | TextMate grammar + `typescriptServerPlugins` manifest |
| `packages/eslint-plugin-mx` | `@markox/eslint-plugin` | MX-specific lint rules (parser is `@babel/eslint-parser` + `babel-plugin-mx`) |
| `packages/mx-vite-plugin` | `@markox/vite-plugin` | Vite transform: prints `.solid.mx` to JSX text ahead of `@solidjs/vite-plugin` (the primary integration) |
| `packages/mx-html` | `@markox/html` | Standalone string-emitting target: whole-file `.mx` templates compile to a pure `(input) => string` function, no runtime beyond an `escape` helper |
| `packages/translator` | `@markox/translator` | The same string target for **stock `.marko`** files, as a `config.translator` for `@marko/compiler`: a working expressions-only mode for Marko, no fork |

**Naming TODO**: the `@markox/*` scope and these short names are placeholders. Final npm names are undecided (see `notes/index.md` in the space root, "Naming on npm").

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
| `@marko/compiler` | 5.42.5 |
| `solid-js` | 2.0.0-rc.7 |
| `@solidjs/web` | 2.0.0-rc.7 |
| `@solidjs/babel-plugin` | 2.0.0-rc.7 |
| `@solidjs/compiler` | 2.0.0-rc.7 |
| `typescript` | 5.9.3 |
| `vitest` | 3.2.7 |
| `@biomejs/biome` | 2.5.12 |
| `@babel/preset-typescript` | 7.29.7 |
| `@types/node` | 26.5.1 |
| `@types/babel__core` | 7.20.5 |
| `@types/babel__generator` | 7.27.0 |
| `charcodes` | 0.2.0 |
| `@babel/helper-validator-identifier` | 7.28.5 |
| `@types/charcodes` | 0.2.2 |
| `@types/babel__helper-validator-identifier` | 7.15.2 |
| `@types/babel__generator` | 7.27.0 |
| `vite` | 8.2.2 |
| `playwright` | 1.63.0 |
| `marko` | 6.3.51 |
| `@marko/compiler` | 5.42.5 |
| `@marko/runtime-tags` | 6.3.51 |
| `parse5` | 7.3.0 |

`marko`/`@marko/compiler`/`@marko/runtime-tags`/`parse5` are pinned in `packages/oracle/package.json`, not the root — they are only a dev dependency of the `oracle:marko` parity check (decision 51), not of the language itself. `@marko/compiler`'s own version numbering is decoupled from the Marko language version; 5.42.5 is the compiler release that ships Marko 6's translator (`marko/translator`) and is what `marko@6.3.51` itself depends on. `parse5` is `oracle:marko`'s HTML parser for semantic (decoded-content) comparison rather than raw-string comparison, pinned to the version already resolved transitively through `@solidjs/babel-plugin`'s own dependency on it.

The last four entries are build-only dependencies of `packages/mx-parser`'s
vendored `@babel/parser` source (`@babel/parser`'s own runtime deps, which
npm's published bundle doesn't need to declare since Babel's build inlines
them) — see `packages/mx-parser/README.md` and `UPSTREAM.md`. A fifth such
dependency, `@babel/helper-string-parser`, is vendored as source instead of
installed as a package (see `UPSTREAM.md`'s "Local modifications"); its
pinned version (7.27.1) is recorded there, not here, since there's no
`package.json` entry for it.

Note: Babel 8 (8.0.x) and TypeScript 7 (7.0.x) were released but are new majors; the spec's parser fork targets Babel 7's `parserOverride`/JSX-plugin shape and TS's current plugin API, so this scaffold pins the latest stable Babel 7 / TypeScript 5 line instead.

### Solid 2 RC policy

SolidMX targets **Solid 2 only**. `babel-preset-solid` and `vite-plugin-solid`
are dead ends: the live packages are `@solidjs/babel-plugin` and
`@solidjs/vite-plugin`, and `@solidjs/compiler` (native Oxc) is the default
backend. Solid 2 is pre-stable — `solid-js`'s npm `latest` is still 1.9.15
and 2.0 lives under the `next` tag, with RCs shipping weekly.

Policy: **pin one RC and stay on it.** Re-sync
`notes/research/solid-2-impact.md` on each bump we choose to take; do not
chase every RC. A milestone in flight finishes against its pinned RC even if
a newer one lands mid-milestone.

## Scripts

Runnable via `bun run <name>` or `moon run :<name>`:

- `typecheck` — `tsc --noEmit` per package and per example
- `test` — `vitest run`
- `lint` — `biome check .`
- `verify` — typecheck, then lint, then build, then test; stops on first failure. Includes `build` so `vendored.test.ts`'s dist-equivalence pass always runs against a fresh `dist/index.js`, not just the pre-build TS source.
- `build` — builds `packages/mx-parser`'s vendored parser to `dist/index.js`
- `oracle` — runs only the oracle/golden harness (`packages/oracle`) and prints a fixture/variant/status summary

## Try it

Runnable Solid 2 apps whose components are written in MX:

```
cd examples/counter-app && bun run dev
cd examples/todomvc && bun run dev
```

`bun run build` builds them, and `bun run e2e` drives the dev server and the
production build through a headless Chromium (needs `bunx playwright install
chromium` once). The e2e suite is not part of the root `bun run test` — it
needs a browser — so it stays behind the example's own script.

`examples/mx-site` is a different kind of example: a Hono-on-Bun server
rendering `.mx` templates to HTML strings with `@markox/html`, no client
runtime, no Solid. It imports `.mx` files directly via `@markox/html/bun`
(no prebuild step). See `examples/mx-site/README.md`.

`examples/mx-vite` is a minimal static-site build: two `.mx` pages compiled
by `@markox/vite-plugin`'s `.mx` handling, bundled by `vite build` to an SSR
entry, then run once to write `dist/*.html`.

```
cd examples/mx-vite && bun run build
```

## Editors

`packages/zed-extension` ships the `MX` language for Zed, backed by the
unmodified `marko-js/tree-sitter` grammar. See its `README.md` for dev-install
steps and the upstream bump procedure.
