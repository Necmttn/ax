#!/usr/bin/env bash
# Start dedicated agentctl SurrealDB instance.
set -euo pipefail

DATA_DIR="${AGENTCTL_DATA_DIR:-$HOME/.local/share/agentctl}"
LOG_DIR="$DATA_DIR/logs"
PORT="${AGENTCTL_DB_PORT:-8521}"
USER="${AGENTCTL_DB_USER:-root}"
PASS="${AGENTCTL_DB_PASS:-root}"

mkdir -p "$DATA_DIR" "$LOG_DIR"

if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  echo "[agentctl] SurrealDB already on port $PORT" >&2
  exit 0
fi

# rocksdb file backend, daemonized
nohup surreal start \
  --user "$USER" --pass "$PASS" \
  --bind "127.0.0.1:$PORT" \
  --log info \
  "rocksdb://$DATA_DIR/db" \
  >>"$LOG_DIR/surreal.log" 2>&1 &

echo $! > "$DATA_DIR/surreal.pid"
sleep 1
echo "[agentctl] SurrealDB pid=$(cat "$DATA_DIR/surreal.pid") port=$PORT data=$DATA_DIR/db"
