#!/usr/bin/env bash
#
# `bun run test` for the grammar package.
#
# Runs, in order, stopping at the first failure:
#   1. tree-sitter test        — the corpus in test/corpus/*.txt
#   2. scripts/parse-all.sh    — zero ERROR/MISSING over every .solid.mx
#   3. scripts/highlight-smoke.sh — queries load and apply to every file
#
# Each step exits non-zero on failure and this script propagates it, so a red
# step cannot be mistaken for a green run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> tree-sitter test"
# `generate` is heavy and must be serialized across agents (Z4). `test` compiles
# the parser on demand, so it takes the same lock.
flock /tmp/mx-zed-generate.lock bunx tree-sitter test

echo
echo "==> parse every .solid.mx fixture and example"
./scripts/parse-all.sh

echo
echo "==> highlight smoke over every .solid.mx fixture and example"
./scripts/highlight-smoke.sh

echo
echo "all grammar checks passed"
