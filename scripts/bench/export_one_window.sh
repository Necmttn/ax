#!/bin/bash
# One surreal sql invocation per ts-window, writing raw --json to its own file.
# Usage: export_one_window.sh <fields> <table> <tsfield> <start-iso> <end-iso> <out-json-file>
set -u
FIELDS="$1"; TABLE="$2"; TSFIELD="$3"; START="$4"; END="$5"; OUT="$6"
SQLFILE="$(mktemp /tmp/exp_win.XXXXXX.sql)"
printf "SELECT %s FROM %s WHERE %s >= d'%s' AND %s < d'%s';\n" \
  "$FIELDS" "$TABLE" "$TSFIELD" "$START" "$TSFIELD" "$END" > "$SQLFILE"
T0=$(date +%s)
surreal sql --endpoint http://127.0.0.1:8521 --ns ax --db main --user root --pass root --hide-welcome --json < "$SQLFILE" > "$OUT" 2>"$OUT.err"
RC=$?
T1=$(date +%s)
echo "rc=$RC dt=$((T1-T0))s bytes=$(wc -c < "$OUT" 2>/dev/null | tr -d ' ')"
rm -f "$SQLFILE"
exit $RC
