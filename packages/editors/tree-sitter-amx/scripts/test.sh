#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> tree-sitter generate & test"
flock /tmp/mx-zed-generate.lock bunx tree-sitter generate
flock /tmp/mx-zed-generate.lock bunx tree-sitter test

echo
echo "==> parse every .amx example"
EXAMPLES_DIR="../../../examples/astro-static/src"
if [ -d "$EXAMPLES_DIR" ]; then
  find "$EXAMPLES_DIR" -name "*.amx" -print0 | xargs -0 -I {} bash -c 'bunx tree-sitter parse "{}" | grep -q "ERROR" && echo "ERROR in {}" && exit 1 || echo "OK {}"'
fi

echo
echo "==> compile src/ from a clean clone of HEAD, as Zed's dev install does"
./scripts/zed-compile-check.sh

echo
echo "all grammar checks passed"

date -u +%s > .test-ran
