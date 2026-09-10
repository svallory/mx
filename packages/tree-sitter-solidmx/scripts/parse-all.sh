#!/usr/bin/env bash
#
# Acceptance gate: every .solid.mx fixture and example must parse with zero
# ERROR and zero MISSING nodes.
#
# Reports a per-file count and exits non-zero if any file is bad OR if the parse
# could not be run at all. Those two cases print differently on purpose: a
# harness that collapses "ran, result was bad" into "clean" proves nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$HERE" || exit 2

mapfile -t FILES < <(
  { find "$REPO_ROOT/fixtures" -name '*.solid.mx' -type f 2>/dev/null
    find "$REPO_ROOT/examples" -name '*.solid.mx' -type f 2>/dev/null
    find "$HERE/fixtures" -name '*.solid.mx' -type f 2>/dev/null
  } | sort
)

# A check must assert it did work, not merely that it found no failures: zero
# errors across zero files satisfies every "no failures" predicate. So require a
# floor on the number of files actually parsed. Raise MIN_FILES when fixtures
# are added; a drop below it means the search found less than it should, which
# is a failure even though nothing "failed".
MIN_FILES="${MX_MIN_PARSE_FILES:-12}"

if [[ ${#FILES[@]} -lt "$MIN_FILES" ]]; then
  echo "parse-all: found only ${#FILES[@]} .solid.mx file(s), expected at least $MIN_FILES" >&2
  echo "  searched: $REPO_ROOT/fixtures, $REPO_ROOT/examples, $HERE/fixtures" >&2
  echo "  (a short list means the search is wrong, not that everything passed)" >&2
  exit 2
fi

bad=0
failed_to_run=0
total=0

for f in "${FILES[@]}"; do
  total=$((total + 1))
  rel="${f#"$REPO_ROOT"/}"

  # `tree-sitter parse` exits non-zero when the tree has errors, so the exit
  # code alone cannot separate "parsed with errors" from "could not parse".
  # Capture output and count the node kinds directly.
  out="$(bunx tree-sitter parse "$f" 2>&1)"
  rc=$?

  if grep -q "Failed to load language\|No such file\|Unable to parse" <<<"$out"; then
    printf '  %-58s COULD NOT RUN\n' "$rel"
    failed_to_run=$((failed_to_run + 1))
    continue
  fi

  errors=$(grep -o 'ERROR' <<<"$out" | wc -l | tr -d ' ')
  missing=$(grep -o 'MISSING' <<<"$out" | wc -l | tr -d ' ')

  if [[ "$errors" -ne 0 || "$missing" -ne 0 ]]; then
    printf '  %-58s ERROR=%s MISSING=%s  <-- FAIL\n' "$rel" "$errors" "$missing"
    bad=$((bad + 1))
  else
    printf '  %-58s ERROR=0 MISSING=0\n' "$rel"
  fi
  # rc is intentionally unused for the verdict; the counts above are the gate.
  : "$rc"
done

echo
echo "parse-all: $total file(s); $bad with errors; $failed_to_run could not run"

# Re-assert the floor on what was actually processed, not just what was found:
# the loop above must have run for every file.
if [[ "$total" -lt "$MIN_FILES" ]]; then
  echo "parse-all: FAILED — processed $total file(s), expected at least $MIN_FILES" >&2
  exit 2
fi

if [[ "$failed_to_run" -ne 0 ]]; then
  echo "parse-all: FAILED — some files could not be parsed at all" >&2
  exit 2
fi
if [[ "$bad" -ne 0 ]]; then
  echo "parse-all: FAILED — $bad file(s) had ERROR or MISSING nodes" >&2
  exit 1
fi
echo "parse-all: OK"
