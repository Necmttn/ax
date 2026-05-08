#!/usr/bin/env bash
set -euo pipefail
DATA_DIR="${AGENTCTL_DATA_DIR:-$HOME/.local/share/agentctl}"
PIDFILE="$DATA_DIR/surreal.pid"
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  kill "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "[agentctl] stopped pid=$pid"
else
  echo "[agentctl] no pidfile"
fi
