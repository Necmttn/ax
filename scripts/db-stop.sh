#!/usr/bin/env bash
set -euo pipefail
DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
PORT="${AX_DB_PORT:-8521}"
PIDFILE="$DATA_DIR/surreal.pid"
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  if kill "$pid" 2>/dev/null; then
    echo "[axctl] stopped pid=$pid"
  else
    echo "[axctl] stale pidfile pid=$pid"
  fi
  rm -f "$PIDFILE"
else
  pid=""
fi

listener_pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$listener_pid" ] && [ "$listener_pid" != "${pid:-}" ]; then
  kill "$listener_pid" 2>/dev/null || true
  echo "[axctl] stopped listener pid=$listener_pid port=$PORT"
elif [ -z "${pid:-}" ]; then
  echo "[axctl] no pidfile and no listener on port $PORT"
fi
