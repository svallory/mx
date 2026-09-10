#!/usr/bin/env bash
# Parses every fixtures-mx/*/input.mx with the vendored MX (Marko) grammar and
# reports how many parse with zero ERROR/MISSING nodes. Any failures are
# upstream Marko grammar gaps, not MX bugs — see the zed-mx report.
#
# tree-sitter is not on PATH; invoked through bunx against the pinned
# tree-sitter-cli devDependency (see package.json).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
FIXTURES_DIR="${FIXTURES_DIR:-"$REPO_ROOT/packages/mx-html/fixtures-mx"}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Fetching marko-js/tree-sitter grammar for parsing..."
(
  cd "$TMP_DIR"
  git init -q
  git remote add origin https://github.com/marko-js/tree-sitter.git
  git fetch -q --depth 1 origin 7fb20382b9b0c97c8bdbceee0e0641bea11dd00f
  git checkout -q FETCH_HEAD
)

# tree-sitter parse needs a tree-sitter.json + grammar dir layout to find the
# language by name; point it at the grammar directly via --scope is not
# supported pre-parse, so we run from inside the grammar checkout and pass
# each fixture's absolute path.
cd "$TMP_DIR"

TOTAL=0
CLEAN=0
ERROR_LIST=()
CRASH_LIST=()

for dir in "$FIXTURES_DIR"/*/; do
  name="$(basename "$dir")"
  input="$dir/input.mx"
  [[ -f "$input" ]] || continue
  TOTAL=$((TOTAL + 1))

  set +e
  OUT="$(bunx --package tree-sitter-cli@0.26.9 tree-sitter parse "$input" 2>&1)"
  RC=$?
  set -e

  # tree-sitter parse itself exits non-zero both when the tree contains an
  # ERROR/MISSING node AND when the invocation fails outright (bad grammar,
  # bad args, etc). Distinguish the two by inspecting the output: an ERROR
  # or MISSING node print means it did parse, just not cleanly.
  if [[ "$RC" -ne 0 ]] && echo "$OUT" | grep -qE '\(ERROR|MISSING'; then
    ERROR_LIST+=("$name")
  elif [[ "$RC" -ne 0 ]]; then
    CRASH_LIST+=("$name")
  else
    CLEAN=$((CLEAN + 1))
  fi
done

if [[ "$TOTAL" -eq 0 ]]; then
  echo "no fixtures found under $FIXTURES_DIR" >&2
  exit 1
fi

echo
echo "Parsed $TOTAL fixtures: $CLEAN clean, ${#ERROR_LIST[@]} with ERROR/MISSING nodes, ${#CRASH_LIST[@]} failed to invoke."

if [[ "${#ERROR_LIST[@]}" -gt 0 ]]; then
  echo "Fixtures with ERROR/MISSING nodes (upstream Marko grammar gaps, not MX bugs):"
  for f in "${ERROR_LIST[@]}"; do
    echo "  - $f"
  done
fi

if [[ "${#CRASH_LIST[@]}" -gt 0 ]]; then
  echo "Fixtures where tree-sitter parse itself failed to run (not a grammar gap — a real invocation problem):"
  for f in "${CRASH_LIST[@]}"; do
    echo "  - $f"
  done
fi

if [[ "${#ERROR_LIST[@]}" -gt 0 || "${#CRASH_LIST[@]}" -gt 0 ]]; then
  exit 1
fi
