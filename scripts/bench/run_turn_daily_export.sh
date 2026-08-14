#!/bin/bash
set -u
cd "$(dirname "$0")"
i=0
fail=0
ok=0
while IFS=$'\t' read -r START END; do
  i=$((i+1))
  OUT="raw/turn_day_$(printf '%03d' $i).json"
  ./export_one_window.sh "id, session, ts, role, text_excerpt" turn ts "$START" "$END" "$OUT" > "$OUT.log" 2>&1
  RC=$?
  BYTES=$(wc -c < "$OUT" 2>/dev/null | tr -d ' ')
  if [ "$RC" -ne 0 ] || [ "${BYTES:-0}" -eq 0 -a -s "$OUT.err" ]; then
    fail=$((fail+1))
    echo "FAIL day $i [$START,$END) $(cat "$OUT.log")"
  else
    ok=$((ok+1))
  fi
done < turn_windows_daily.tsv
echo "DONE ok=$ok fail=$fail total=$i"
