---
title: "Contributing"
description: "Repo layout, verification, the oracle, and how to add a host."
---

# Contributing

## Repo layout

The repository is a Bun workspace with two workspace globs, `packages/*` and `examples/*`, plus a docs app under `apps/*`. Notable packages:

| Package | Purpose |
|---|---|
| `packages/mx-parser` | A `@babel/parser` fork: MX in expression position lowers to JSX, for the SolidMX host. |
| `packages/core` | The Marko-node consumer every MX host is built on: structural lowerings, the `Policy` contract, three stateful-tag hooks, two front doors. |
| `packages/translator` | The HTML host: `.mx`/`.marko` compile to a pure `(input) => string` function. |
| `packages/astro` | The Astro host: components, pages, and `.amx` templates, all rendered to static markup. |
| `packages/language-server` | A diagnostics-only LSP server for MX hosts. |
| `packages/zed-extension` | The Zed editor extension (three languages plus the language server registration). |
| `packages/oracle` | The parity-checking harness described below. |

Each package publishes its own README with install instructions, API surface, and implementation notes specific to that package — the pages under [Hosts](/hosts/html/) and [Editors](/editors/zed/) summarize the parts a consumer needs; the READMEs go deeper for a contributor.

## Verify and its rules

`bun run verify` (or `moon run :verify`) is the single command that must pass before anything merges. It chains: a pre-verify step that clears stale test evidence, a build, a typecheck pass, lint, the vitest suite, the Bun-runtime test suite, the tree-sitter grammar test, a consumer-facing smoke check, and a coverage-verification script — in that order, because later steps depend on artifacts earlier steps produce.

Three rules this chain is built around:

- **A check that can never fail is not a check.** Every gate in the chain is expected to be able to fail, and is proven to fail at least once against a deliberately broken input before it's trusted. A script that only prints success is a bug, not a safety net.
- **Evidence, not vibes.** The coverage-verification step doesn't ask "does this package have test files" — it reads the actual output of the test run that just happened (a JSON report, or a marker file written only on success) and checks its timestamp is newer than the start of this verification run. A package can't be marked "tested" by leftover evidence from a previous run.
- **Clean-clone proofs.** Anything that depends on generated or vendored files (a build step, a vendored grammar) is expected to work from a fresh clone with no manual setup step, and CI is what actually proves this — a green run on a contributor's machine with stale local state doesn't count.

## The docs site as a verify step

This site (`apps/docs`) is wired into `verify` and CI the same way: `bun run --cwd apps/docs build` runs as part of the chain, and a broken page — a bad internal link, invalid config, a markdown file that fails to parse — fails the build and fails verify. The generated `site/` output directory is not committed.

## The oracle

The oracle harness compares compiled output between an MX source file and a hand-written equivalent in the target framework's own syntax, across every backend and output variant that target supports. It exists so that a change to the structural core or a host's policy can be checked against real, working reference code rather than only against expectations recorded in a test file.

A parallel harness checks the structural core specifically against real Marko: since MX 1.0 is a strict subset of Marko syntax, the same fixture rendered through Marko's own toolchain and through an MX host should produce semantically equivalent HTML. This is the regression guard for the subset rule itself — if MX's rendering of the structural core ever drifts from what Marko would produce for the same input, this is what catches it.

## How to add a host

A host is a `Policy` implementation over `@mxlang/core` plus whatever integration glue its target ecosystem needs (a bundler plugin, a loader, a framework-specific renderer). Concretely:

1. Decide what your target's "public input language" is — the ordinary source format its own toolchain already knows how to compile (JSX text, a plain string-returning function, etc.).
2. Implement the `Policy` interface: which tags are elements vs. components, how attribute values are structured, and — if your host wants any stateful tags to mean something — the three hooks (a tag handler, a way to hoist a statement, and a way to rewrite identifier references).
3. Decide whether your host reuses the core's default string-emit model (appropriate for a statement-shaped string target) or needs to replace the emit layer entirely (appropriate for an expression-shaped target like JSX).
4. Add fixtures and wire your host into the oracle so its output is checked against real reference code, not only assertions in a test file.

See [Core and hosts](/architecture/core-and-hosts/) and [Policy and hooks](/architecture/policy-and-hooks/) for the interface itself.

## How to add a fixture

A fixture for the Marko-parity oracle lives in its own directory alongside a plain `.marko` input file, a small JSON file of props to render it with, and an `expected.html` file — generated from a real run of Marko's own toolchain, never hand-written, so the comparison is always against ground truth rather than a guess at what Marko would do. A fixture for the framework-parity oracle instead pairs an MX source file with a hand-written twin in the target framework's native syntax; both are compiled and their outputs compared across every backend and variant the target supports.
