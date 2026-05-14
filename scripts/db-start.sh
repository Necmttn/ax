#!/usr/bin/env bash
# Start dedicated axctl SurrealDB instance.
set -euo pipefail

DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
LOG_DIR="$DATA_DIR/logs"
BUCKETS_DIR="$DATA_DIR/buckets"
PORT="${AX_DB_PORT:-${AGENTCTL_DB_PORT:-8521}}"
USER="${AX_DB_USER:-${AGENTCTL_DB_USER:-root}}"
PASS="${AX_DB_PASS:-${AGENTCTL_DB_PASS:-root}}"

mkdir -p "$DATA_DIR" "$LOG_DIR" "$BUCKETS_DIR/transcripts" "$BUCKETS_DIR/codex_artifacts"

if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  echo "[axctl] SurrealDB already on port $PORT" >&2
  exit 0
fi

# rocksdb file backend, daemonized
# --allow-experimental files: enables DEFINE BUCKET + f"bucket:/path" file syntax (SurrealDB 3.0)
# SURREAL_BUCKET_FOLDER_ALLOWLIST: required allowlist for file:// backed buckets
SURREAL_BUCKET_FOLDER_ALLOWLIST="$BUCKETS_DIR" \
nohup surreal start \
  --user "$USER" --pass "$PASS" \
  --bind "127.0.0.1:$PORT" \
  --log info \
  --allow-experimental=files \
  "rocksdb://$DATA_DIR/db" \
  >>"$LOG_DIR/surreal.log" 2>&1 &

echo $! > "$DATA_DIR/surreal.pid"
sleep 1
echo "[axctl] SurrealDB pid=$(cat "$DATA_DIR/surreal.pid") port=$PORT data=$DATA_DIR/db buckets=$BUCKETS_DIR"
