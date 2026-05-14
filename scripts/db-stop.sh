#!/usr/bin/env bash
set -euo pipefail
DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
PIDFILE="$DATA_DIR/surreal.pid"
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  kill "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "[axctl] stopped pid=$pid"
else
  echo "[axctl] no pidfile"
fi
