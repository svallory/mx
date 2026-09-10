#!/usr/bin/env bash
# Builds languages/mx/*.scm from two pinned upstreams, plus overlays.
#
# Sources (see UPSTREAM.md for exact pins):
#   - marko-js/tree-sitter  queries/highlights.scm, queries/injections.scm
#   - marko-js/zed          languages/marko/brackets.scm, languages/marko/outline.scm
#
# For each of the four query names this script:
#   1. fetches the pinned file from its upstream repo at its pinned rev
#   2. applies patches/<name>.patch to it, if that file exists (git apply)
#   3. concatenates overlay/mx/<name>.scm onto the result
#   4. writes the result to languages/mx/<name>.scm
#
# Zed reads exactly one file per query name (see notes/zed-extension-decisions.md
# Z6) — there is no multi-file merge at load time, so this concatenation has to
# happen here, at build time, instead.
#
# Usage:
#   scripts/vendor.sh            # (re)generate languages/mx/*.scm from the pins below
#   scripts/vendor.sh --check    # compare pinned shas against upstream HEAD; exit
#                                 # non-zero on drift; changes nothing on disk
#
# Never hand-edit languages/mx/*.scm — edit overlay/mx/*.scm or add a patch
# instead, then rerun this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PKG_DIR/languages/mx"
OVERLAY_DIR="$PKG_DIR/overlay/mx"
PATCHES_DIR="$PKG_DIR/patches"

TS_REPO="https://github.com/marko-js/tree-sitter.git"
TS_REV="7fb20382b9b0c97c8bdbceee0e0641bea11dd00f"

ZED_REPO="https://github.com/marko-js/zed.git"
ZED_REV="dd854edec1fab86d23eb24af9691505dfe3856a6"

CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

clone_at() {
  # clone_at <repo-url> <rev> <dest-dir>
  local repo="$1" rev="$2" dest="$3"
  mkdir -p "$dest"
  (
    cd "$dest"
    git init -q
    git remote add origin "$repo"
    git fetch -q --depth 1 origin "$rev"
    git checkout -q FETCH_HEAD
  )
}

remote_head() {
  # remote_head <repo-url> [branch] -- prints the sha at the tip of <branch>
  # (default HEAD, i.e. the repo's default branch)
  local repo="$1" branch="${2:-HEAD}"
  git ls-remote "$repo" "$branch" | cut -f1
}

if [[ "$CHECK" -eq 1 ]]; then
  echo "Checking upstream drift..."
  TS_HEAD="$(remote_head "$TS_REPO")"
  ZED_HEAD="$(remote_head "$ZED_REPO")"

  DRIFT=0
  if [[ "$TS_HEAD" != "$TS_REV" ]]; then
    echo "DRIFT  marko-js/tree-sitter: pinned $TS_REV, upstream HEAD is $TS_HEAD"
    DRIFT=1
  else
    echo "clean  marko-js/tree-sitter: $TS_REV"
  fi
  if [[ "$ZED_HEAD" != "$ZED_REV" ]]; then
    echo "DRIFT  marko-js/zed: pinned $ZED_REV, upstream HEAD is $ZED_HEAD"
    DRIFT=1
  else
    echo "clean  marko-js/zed: $ZED_REV"
  fi

  if [[ "$DRIFT" -eq 1 ]]; then
    echo "Upstream drift detected."
    exit 1
  fi
  echo "No drift."
  exit 0
fi

echo "Fetching marko-js/tree-sitter @ $TS_REV..."
clone_at "$TS_REPO" "$TS_REV" "$TMP_DIR/tree-sitter"

echo "Fetching marko-js/zed @ $ZED_REV..."
clone_at "$ZED_REPO" "$ZED_REV" "$TMP_DIR/zed"

mkdir -p "$OUT_DIR"

build_query() {
  # build_query <name> <upstream-file>
  local name="$1" upstream_file="$2"
  local work="$TMP_DIR/$name.scm"
  local patch="$PATCHES_DIR/$name.patch"
  local overlay="$OVERLAY_DIR/$name.scm"
  local out="$OUT_DIR/$name.scm"

  cp "$upstream_file" "$work"

  if [[ -f "$patch" ]]; then
    echo "  applying patches/$name.patch"
    git apply --unsafe-paths --directory="$(dirname "$work")" "$patch"
  fi

  {
    cat "$work"
    if [[ -f "$overlay" ]]; then
      echo
      echo "; --- MX overlay (overlay/mx/$name.scm) ---"
      cat "$overlay"
    fi
  } > "$out"

  echo "  wrote languages/mx/$name.scm"
}

echo "Building queries..."
build_query "highlights" "$TMP_DIR/tree-sitter/queries/highlights.scm"
build_query "injections" "$TMP_DIR/tree-sitter/queries/injections.scm"
build_query "brackets"   "$TMP_DIR/zed/languages/marko/brackets.scm"
build_query "outline"    "$TMP_DIR/zed/languages/marko/outline.scm"

echo "Done. languages/mx/*.scm regenerated from pinned upstreams + overlays."
