#!/usr/bin/env bash
# Builds languages/solidmx/*.scm from this monorepo's own tree-sitter-solidmx
# package plus hand-authored base content and overlays.
#
# Sources (see UPSTREAM.md for exact provenance):
#   - packages/editors/tree-sitter-solidmx  queries/highlights.scm (in-repo, not fetched
#     over the network — that package's own UPSTREAM.md/vendor.sh own the
#     tree-sitter-typescript pin this grammar is built from)
#   - base/solidmx/{injections,brackets,outline}.scm  hand-authored base content
#     for SolidMX (no reference Zed extension exists for this grammar, so
#     these play the role a `marko-js/zed`-style upstream would)
#
# For each of the four query names, this script:
#   1. takes the base content — a local sibling package's file (highlights),
#      or a hand-authored base/solidmx/<name>.scm (injections/brackets/outline)
#   2. concatenates overlay/solidmx/<name>.scm onto the result
#   3. writes the result to languages/solidmx/<name>.scm
#
# Zed reads exactly one file per query name (see notes/zed-decisions.md
# Z6) — there is no multi-file merge at load time, so this concatenation has to
# happen here, at build time, instead.
#
# Usage:
#   scripts/vendor.sh              # (re)generate languages/solidmx/*.scm
#
# There is no `--check` mode: SolidMX's highlights source is local (this
# monorepo), so there is no networked upstream HEAD to drift against — a
# `--check` here could only ever report success, and a gate that cannot fail
# is not a gate (decision 55). `upstream-check.yml`'s `vendored-files-match`
# job does the only check that matters for this script: regenerate and diff
# against committed output.
#
# Never hand-edit languages/solidmx/*.scm — edit overlay/solidmx/*.scm,
# base/solidmx/*.scm instead, then rerun this script.

set -euo pipefail

if [[ $# -gt 0 ]]; then
  echo "usage: $0   (no arguments — this script only regenerates; see its header comment)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"

SOLIDMX_OUT_DIR="$PKG_DIR/languages/solidmx"
SOLIDMX_OVERLAY_DIR="$PKG_DIR/overlay/solidmx"
SOLIDMX_BASE_DIR="$PKG_DIR/base/solidmx"
TREE_SITTER_SOLIDMX_DIR="$(cd "$PKG_DIR/../tree-sitter-solidmx" && pwd)"

build_query_solidmx() {
  # build_query_solidmx <name> <base-file>
  local name="$1" base_file="$2"
  local overlay="$SOLIDMX_OVERLAY_DIR/$name.scm"
  local out="$SOLIDMX_OUT_DIR/$name.scm"

  {
    cat "$base_file"
    if [[ -f "$overlay" ]]; then
      echo
      echo "; --- SolidMX overlay (overlay/solidmx/$name.scm) ---"
      cat "$overlay"
    fi
  } > "$out"

  echo "  wrote languages/solidmx/$name.scm"
}

echo "Building SolidMX queries..."
mkdir -p "$SOLIDMX_OUT_DIR"
build_query_solidmx "highlights" "$TREE_SITTER_SOLIDMX_DIR/queries/highlights.scm"
build_query_solidmx "injections" "$SOLIDMX_BASE_DIR/injections.scm"
build_query_solidmx "brackets"   "$SOLIDMX_BASE_DIR/brackets.scm"
build_query_solidmx "outline"    "$SOLIDMX_BASE_DIR/outline.scm"

echo "Done. languages/solidmx/*.scm regenerated from packages/editors/tree-sitter-solidmx + base/solidmx + overlays."
