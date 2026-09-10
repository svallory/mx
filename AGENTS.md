# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn. Toolchain versions are pinned in `.prototools` (`bun`, `moon`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- typecheck, then lint, then test; stops on first failure
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root — so pick one command style (bun or moon) per invocation rather than mixing them.

## Exact-pin policy

All dependencies in the root `package.json` are pinned to an exact version (no `^`/`~`). `mx-parser`'s output must be byte-reproducible wire format across the parser, the Babel plugin, and the TS plugin's virtual-file generator; an unpinned transitive bump in Babel or TypeScript could silently change AST shape or emitted output. See `README.md` "Pinned versions" for the current set and rationale.

## Base branch

`main`.

## Commit convention

Conventional commits: `type(scope): summary`.

## Design docs

Design docs, specs, and research notes live outside this repo, at the project space root under `notes/` (not inside this worktree).

## Oracle harness

`packages/oracle` (`@mx/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, for both Solid generate variants. `bun run oracle` runs it standalone and prints a fixture/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

A `skipped` status is not a pass: until `@mx/parser` exists, `.solid.mx` compiles throw `MxParserUnavailable` and every fixture reports `skipped`. Only `pass`, `fail`, or `divergent` mean the parser actually ran.

Golden snapshots (`fixtures/<name>/__golden__/twin.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a `babel-preset-solid`/`solid-js` pin bump changing generated code. Regenerate them deliberately (delete the stale file, rerun `bun run oracle`) and call it out in the PR — never let a pin bump change them as a silent side effect.
