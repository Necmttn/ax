#!/usr/bin/env bash
# Recomputes the bun-deps fixed-output hash in flake.nix.
# Strategy: set hash to a known fake, run `nix build`, parse the "got:" line.
set -euo pipefail

FLAKE="${FLAKE:-flake.nix}"
ATTR="${ATTR:-.#ax}"
FAKE="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

if [[ ! -f "$FLAKE" ]]; then
  echo "error: $FLAKE not found" >&2
  exit 1
fi

current=$(rg -oN 'outputHash = "(sha256-[^"]+)"' -r '$1' "$FLAKE" | head -1)
if [[ -z "$current" ]]; then
  echo "error: no outputHash found in $FLAKE" >&2
  exit 1
fi

cleanup() {
  if [[ -f "$FLAKE.bak" ]]; then mv "$FLAKE.bak" "$FLAKE"; fi
}
trap cleanup EXIT

cp "$FLAKE" "$FLAKE.bak"
# Use perl for portable in-place edit (works on macOS + Linux).
perl -i -pe 's|outputHash = "sha256-[^"]+";|outputHash = "'"$FAKE"'";|' "$FLAKE"

set +e
build_out=$(nix build "$ATTR" --no-link 2>&1)
status=$?
set -e

if [[ $status -eq 0 ]]; then
  # Fake hash somehow matched (extremely unlikely); restore original.
  echo "nix build unexpectedly succeeded with fake hash; aborting" >&2
  exit 1
fi

got=$(printf '%s\n' "$build_out" | rg -oN 'got:[[:space:]]+(sha256-[A-Za-z0-9+/=]+)' -r '$1' | head -1)
if [[ -z "$got" ]]; then
  echo "error: failed to extract new hash from nix output:" >&2
  printf '%s\n' "$build_out" >&2
  exit 1
fi

# Apply real hash to the original file (restored on EXIT trap if we bail here).
mv "$FLAKE.bak" "$FLAKE"
trap - EXIT
perl -i -pe 's|outputHash = "sha256-[^"]+";|outputHash = "'"$got"'";|' "$FLAKE"

if [[ "$current" == "$got" ]]; then
  echo "hash unchanged: $got"
else
  echo "hash updated: $current -> $got"
fi

# Verify the new hash actually builds.
nix build "$ATTR" --no-link >/dev/null
echo "verified: nix build $ATTR succeeds"
