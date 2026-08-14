#!/bin/bash
# Flatten per-window raw --json files (each `[[{...},{...}]]`) into one JSONL file.
# Usage: consolidate.sh <raw-glob> <out.jsonl>
set -u
GLOB="$1"; OUT="$2"
: > "$OUT"
n=0
for f in $GLOB; do
  [ -s "$f" ] || continue
  jq -c '.[0][]' "$f" >> "$OUT" 2>>"$OUT.err"
  n=$((n+1))
done
echo "consolidated $n files -> $OUT ($(wc -l < "$OUT" | tr -d ' ') rows, $(wc -c < "$OUT" | tr -d ' ') bytes)"
