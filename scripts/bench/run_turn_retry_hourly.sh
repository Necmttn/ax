#!/bin/bash
set -u
cd "$(dirname "$0")"
i=0
fail=0
ok=0
while IFS=$'\t' read -r START END; do
  i=$((i+1))
  OUT="raw/turn_retryh_$(printf '%03d' $i).json"
  ./export_one_window.sh "id, session, ts, role, text_excerpt" turn ts "$START" "$END" "$OUT" > "$OUT.log" 2>&1
  RC=$?
  if [ "$RC" -ne 0 ] || [ -s "$OUT.err" ]; then
    fail=$((fail+1))
    echo "FAIL hour $i [$START,$END) $(cat "$OUT.log")"
  else
    ok=$((ok+1))
  fi
done < turn_retry_hourly.tsv
echo "DONE ok=$ok fail=$fail total=$i"
