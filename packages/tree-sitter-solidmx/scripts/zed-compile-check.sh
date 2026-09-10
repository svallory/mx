#!/usr/bin/env bash
# Reproduces Zed's own grammar compile step against a CLEAN CLONE of this
# repo at HEAD — i.e. only committed files, never the working tree. This is
# the gate that would have caught the real defect Zed's dev install hit:
# src/scanner.c reaching outside src/ for a header that lives in .gitignore'd
# vendor/. Every other check in this package (tree-sitter test, tree-sitter
# generate, parse-all.sh, highlight-smoke.sh) runs against the working tree,
# where vendor.sh has already populated vendor/ — none of them can see this
# class of defect. This script exists specifically to close that gap.
#
# Mirrors Zed's own build (crates/extension/src/extension_builder.rs,
# compile_grammar): clang -fPIC -shared -Os -Wl,--export=tree_sitter_<name>
# -I <src> <parser.c> [<scanner.c> if present] -o <name>.wasm, using Zed's
# own wasi-sdk clang when available.
#
# Usage: scripts/zed-compile-check.sh
# Exit 0: compiled clean, grammar.wasm produced and non-empty.
# Exit 1: compile failed (prints clang's own first error) or wasm missing/empty.
# Exit 2: could not run the check at all (no repo, no clang found anywhere).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PKG_REL="packages/tree-sitter-solidmx"
GRAMMAR_NAME="solidmx"

# Zed's own wasi-sdk clang, if this machine has installed the extension at
# least once (it ships wasi-sdk under Zed's own app-support directory, not
# on PATH). Falls back to `tree-sitter build --wasm`, which uses emscripten
# instead — a different toolchain, but the same "committed files only"
# property this gate needs, since it also compiles from the clean clone.
ZED_WASI_CLANG="$HOME/Library/Application Support/Zed/extensions/build/wasi-sdk/bin/clang"

if ! command -v git >/dev/null 2>&1; then
  echo "zed-compile-check.sh: git not found" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CLONE_DIR="$TMP_DIR/clone"

# Clone the whole monorepo (this grammar has no repo of its own yet — it
# lives nested at $PKG_REL, same as extension.toml's file:// + path dev
# form), at HEAD, so only committed files are present. This mirrors exactly
# what Zed's checkout_repo does for [grammars.solidmx].
echo "Cloning committed HEAD only (file://$REPO_ROOT, at $PKG_REL)..."
git clone --quiet --depth 1 "file://$REPO_ROOT" "$CLONE_DIR"

SRC_DIR="$CLONE_DIR/$PKG_REL/src"
PARSER_C="$SRC_DIR/parser.c"
SCANNER_C="$SRC_DIR/scanner.c"
WASM_OUT="$TMP_DIR/$GRAMMAR_NAME.wasm"

if [[ ! -f "$PARSER_C" ]]; then
  echo "zed-compile-check.sh: $PARSER_C missing from committed HEAD" >&2
  exit 2
fi

if [[ -x "$ZED_WASI_CLANG" ]]; then
  echo "Compiling with Zed's own wasi-sdk clang: $ZED_WASI_CLANG"
  set +e
  "$ZED_WASI_CLANG" -fPIC -shared -Os \
    "-Wl,--export=tree_sitter_${GRAMMAR_NAME}" \
    -o "$WASM_OUT" \
    -I "$SRC_DIR" \
    "$PARSER_C" \
    $( [[ -f "$SCANNER_C" ]] && echo "$SCANNER_C" ) \
    2> "$TMP_DIR/clang-stderr.log"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "zed-compile-check.sh: clang failed (exit $rc)" >&2
    head -n 5 "$TMP_DIR/clang-stderr.log" >&2
    exit 1
  fi
else
  echo "Zed's wasi-sdk clang not found at $ZED_WASI_CLANG; falling back to 'tree-sitter build --wasm'"
  if ! command -v bunx >/dev/null 2>&1; then
    echo "zed-compile-check.sh: no wasi-sdk clang and no bunx to fall back to tree-sitter build" >&2
    exit 2
  fi
  set +e
  (cd "$CLONE_DIR/$PKG_REL" && bunx --package "tree-sitter-cli@0.24.7" tree-sitter build --wasm -o "$WASM_OUT") \
    2> "$TMP_DIR/tsbuild-stderr.log"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "zed-compile-check.sh: tree-sitter build --wasm failed (exit $rc)" >&2
    head -n 5 "$TMP_DIR/tsbuild-stderr.log" >&2
    exit 1
  fi
fi

if [[ ! -s "$WASM_OUT" ]]; then
  echo "zed-compile-check.sh: $WASM_OUT missing or empty after a reported-successful compile" >&2
  exit 1
fi

echo "zed-compile-check.sh: OK — $(basename "$WASM_OUT") compiled from a clean clone of HEAD ($(wc -c < "$WASM_OUT") bytes)"
