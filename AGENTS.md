# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn. Toolchain versions are pinned in `.prototools` (`bun`, `moon`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- typecheck, then lint, then build, then test; stops on first failure
bun run build       # or: moon run mx-parser:build -- builds packages/mx-parser to dist/
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root — so pick one command style (bun or moon) per invocation rather than mixing them.

## Edit check hook

`.claude/hyper.json` runs Biome formatting checks, then per-package TypeScript type checking via `tsc --noEmit` after every agent edit. Both commands use `./node_modules/.bin` paths directly so they work without shell shims (proto/bun/nvm wrappers).

## Exact-pin policy

All dependencies in the root `package.json` are pinned to an exact version (no `^`/`~`). `mx-parser`'s output must be byte-reproducible wire format across the parser, the Babel plugin, and the TS plugin's virtual-file generator; an unpinned transitive bump in Babel or TypeScript could silently change AST shape or emitted output. See `README.md` "Pinned versions" for the current set and rationale.

## Base branch

`main`.

## Commit convention

Conventional commits: `type(scope): summary`.

## MX parser

`packages/mx-parser` vendors `@babel/parser` 7.29.8 and forks one method of its JSX plugin so `<` in expression position is parsed as MX. Entry points:

- `parse(source, filename, options?)` — parses `.solid.mx`, returns a Babel `File` of standard node types only (MX facts go in `node.extra.mx`).
- `parseBabel` / `parseBabelExpression` — the untouched vendored `@babel/parser` surface, for plain `.ts`/`.tsx`.

MX parsing is opt-in through the `mx` parser option, which `parse` sets. Without it the vendored parser is byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, so keep those tests on `parseBabel` rather than `parse`. `packages/mx-parser/UPSTREAM.md` "Local modifications" records exactly what the fork changed.

Consumers typecheck against `src/public.d.ts`, not `src/index.ts`: the vendored tree needs tsconfig relaxations that must not leak into packages that merely call `parse`.

Two syntax decisions are settled and encoded in the lowering table:

- **Whitespace follows Marko, not JSX.** A whitespace-only text run containing a newline is dropped entirely, so indented markup renders nothing between children; a whitespace-only run without a newline collapses to one space. `${" "}` is the escape hatch. Comments are dropped from the output and do not count as content when trimming.
- **Void elements need no slash.** `<input value=x>` parses. The set (`area base br col embed hr img input link meta param source track wbr`) is declared to htmljs-parser as `TagType.void`; a void tag written with a closing tag is a parse error.
- **Shorthand/explicit attribute conflicts are parse errors, not merges.** `.class` shorthand combined with a non-string `class={...}` (including an object literal, which would otherwise route to `classList`) is a parse error, as is `#id` shorthand combined with an explicit `id=`. Shorthand plus a *string* `class="x"` is the one allowed merge (`class="card x"`, shorthand first). `style=` only accepts an object-literal value (`style={color: c()}` → `style={{color: c()}}`); any other `style=` expression is a parse error for v1.
- **Tag params (`|a, b|`) come before `=value`.** `<if|u|=user()>`, not `<if=user()|u|>` — the latter parses but folds `|u|` into the condition expression and reports no params, matching `<for|item, i| of=...>`'s own order. `notes/solidmx-spec.md` §5.1 writes `<if=user()|u|>` as loose prose; the real grammar is params-first.

## Design docs

Design docs, specs, and research notes live outside this repo, at the project space root under `notes/` (not inside this worktree).

## Oracle harness

`packages/oracle` (`@mx/oracle`) compares compiled `dom-expressions` output between `fixtures/<name>/input.solid.mx` and its hand-written `fixtures/<name>/twin.tsx` twin, for both Solid generate variants. `bun run oracle` runs it standalone and prints a fixture/variant/status table; see `fixtures/README.md` for the fixture and `divergences.md` contract.

`@mx/parser` is wired into the harness (`packages/oracle` depends on it and `report.ts` passes its `parse` as `mxParser`), so fixtures compile for real. Statuses: `pass`, `fail` and `divergent` mean the parser ran; `skipped` means no parser was available (now a real failure, not "not implemented"); `pending` means the fixture carries a `PENDING` marker naming constructs the parser cannot lower yet. Neither `skipped` nor `pending` is a pass, and `--strict` fails the run on either — see `fixtures/README.md` for the `PENDING` contract.

Current state: `counter`, `todos`, and `attrs` all pass both variants. So `bun run oracle` and `bun run oracle -- --strict` both exit 0.

`packages/oracle/src/compile.ts` runs `@babel/preset-typescript` after parsing `.solid.mx` too, not only `.tsx`: the vendored MX parser accepts TS syntax (interfaces, type annotations, generics) but `mxParser`'s `parserOverride` only replaces the *parse* step, not the erasure pass, so TS type nodes are still in the AST afterward and need the same stripping a `.tsx` file gets — or they leak into the compiled output and break byte parity against a twin that went through the ordinary TS pipeline.

Golden snapshots (`fixtures/<name>/__golden__/twin.<variant>.js`) pin `twin.tsx`'s own compiled output, independent of MX, to catch a `babel-preset-solid`/`solid-js` pin bump changing generated code. Regenerate them deliberately with `bun run oracle -- --update` and call it out in the PR — never let a pin bump change them as a silent side effect.

`packages/mx-parser/src/mx/perf.test.ts`'s 500ms wall-clock budget only fails the test when `MX_PERF_STRICT` is set; otherwise it just `console.warn`s past the budget, since a plain `bun run verify` under machine contention (several agents/verifiers at once) can blow well past 500ms with no actual parser regression.
