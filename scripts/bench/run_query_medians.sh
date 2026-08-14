#!/bin/bash
# Run a DuckDB query file 6x (1 warm-up + 5 timed), print all 5 timed reals + median.
set -u
cd "$(dirname "$0")"
DUCKDB=/private/tmp/claude-501/-Users-necmttn-Projects-ax/804f55a8-97eb-4c19-8b56-9e49dd1cffd9/scratchpad/spike-b/duckdb/build/release/duckdb
FILE="$1"
echo "=== $FILE (warm-up + 5 runs) ==="
# warm-up (discarded)
$DUCKDB bench.duckdb < "$FILE" > /dev/null 2>/tmp/qwarm.err
times=()
for i in 1 2 3 4 5; do
  OUT=$($DUCKDB bench.duckdb < "$FILE" 2>/tmp/qrun.err)
  T=$(echo "$OUT" | grep "Run Time" | tail -1 | sed -E 's/.*real ([0-9.]+).*/\1/')
  echo "run $i: ${T}s"
  times+=("$T")
done
# median of 5
python3 -c "
import sys
vals = sorted(float(x) for x in '${times[*]}'.split())
n = len(vals)
med = vals[n//2] if n % 2 == 1 else (vals[n//2-1]+vals[n//2])/2
print(f'median: {med:.4f}s  (all: {vals})')
"
