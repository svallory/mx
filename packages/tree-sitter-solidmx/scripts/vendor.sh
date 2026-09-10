#!/usr/bin/env bash
#
# Vendor tree-sitter-typescript's tsx dialect and apply the MX patches.
#
# Usage:
#   ./scripts/vendor.sh            # fetch upstream at the pin, apply patches/*.patch
#   ./scripts/vendor.sh --check    # verify vendor/ matches upstream+patches; no writes
#
# --check exists because the vendored tree is a build input: if someone edits
# vendor/ by hand instead of adding a patch, the next re-vendor silently reverts
# it. --check fails loudly in that case (see UPSTREAM.md "Bump procedure").
set -euo pipefail

REPO_URL="https://github.com/tree-sitter/tree-sitter-typescript.git"
# Pinned tag v0.23.2 (2024-11-10), the latest tag at vendoring time.
PIN_SHA="f975a621f4e7f532fe322e13c4f79495e0a7b2e7"
PIN_TAG="v0.23.2"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$HERE/vendor/tree-sitter-typescript"
PATCH_DIR="$HERE/patches"

CHECK_MODE=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=1
elif [[ $# -gt 0 ]]; then
  echo "vendor.sh: unknown argument '$1' (expected --check or nothing)" >&2
  exit 2
fi

# Fetch upstream at the pin into $1. Uses a blobless clone: the full history of
# this repo is large and only one tree is needed.
fetch_upstream() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  git -c advice.detachedHead=false clone --quiet --filter=blob:none \
    "$REPO_URL" "$dest" >/dev/null
  git -C "$dest" -c advice.detachedHead=false checkout --quiet "$PIN_SHA"

  local got
  got="$(git -C "$dest" rev-parse HEAD)"
  if [[ "$got" != "$PIN_SHA" ]]; then
    echo "vendor.sh: checked out $got, expected pin $PIN_SHA ($PIN_TAG)" >&2
    exit 1
  fi
  # Drop upstream's own git metadata; the vendored tree is content, not a repo.
  rm -rf "$dest/.git"
}

apply_patches() {
  local dest="$1"
  shopt -s nullglob
  local patches=("$PATCH_DIR"/*.patch)
  shopt -u nullglob

  if [[ ${#patches[@]} -eq 0 ]]; then
    echo "vendor.sh: no patches in $PATCH_DIR — refusing to vendor an unpatched tree" >&2
    echo "  (an unpatched vendor/ would silently drop every MX modification)" >&2
    exit 1
  fi

  local p
  for p in "${patches[@]}"; do
    if ! git -C "$dest" apply --whitespace=nowarn "$p"; then
      echo "vendor.sh: failed to apply $(basename "$p")" >&2
      echo "  Upstream likely drifted. See UPSTREAM.md 'Bump procedure'." >&2
      exit 1
    fi
  done
}

if [[ "$CHECK_MODE" -eq 1 ]]; then
  if [[ ! -d "$VENDOR_DIR" ]]; then
    echo "vendor.sh --check: $VENDOR_DIR does not exist; run ./scripts/vendor.sh" >&2
    exit 1
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch_upstream "$TMP/expected"
  apply_patches "$TMP/expected"

  # Compare only the files the grammar build actually consumes. Upstream ships
  # bindings, CI config and prebuilt parsers for dialects MX does not use;
  # diffing those would make --check fail on noise.
  status=0
  for rel in common/define-grammar.js common/scanner.h tsx/grammar.js; do
    if ! diff -u "$TMP/expected/$rel" "$VENDOR_DIR/$rel" >/dev/null 2>&1; then
      echo "vendor.sh --check: DRIFT in $rel" >&2
      diff -u "$TMP/expected/$rel" "$VENDOR_DIR/$rel" >&2 || true
      status=1
    fi
  done

  if [[ "$status" -ne 0 ]]; then
    echo "vendor.sh --check: vendor/ does not match upstream $PIN_TAG + patches/" >&2
    echo "  Re-run ./scripts/vendor.sh, or capture your edit as a patch." >&2
    exit 1
  fi
  echo "vendor.sh --check: OK (upstream $PIN_TAG $PIN_SHA + ${PATCH_DIR##*/}/*.patch)"
  exit 0
fi

fetch_upstream "$VENDOR_DIR"
apply_patches "$VENDOR_DIR"
echo "vendor.sh: vendored $PIN_TAG ($PIN_SHA) into ${VENDOR_DIR#"$HERE"/} + patches applied"
