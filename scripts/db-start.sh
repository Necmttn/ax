#!/usr/bin/env bash
# Start dedicated axctl SurrealDB instance.
set -euo pipefail

DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
LOG_DIR="$DATA_DIR/logs"
BUCKETS_DIR="$DATA_DIR/buckets"
PORT="${AX_DB_PORT:-${AGENTCTL_DB_PORT:-8521}}"
USER="${AX_DB_USER:-${AGENTCTL_DB_USER:-root}}"
PASS="${AX_DB_PASS:-${AGENTCTL_DB_PASS:-root}}"
ROCKSDB_BLOCK_CACHE_SIZE="${AX_DB_ROCKSDB_BLOCK_CACHE_SIZE:-268435456}"
ROCKSDB_WRITE_BUFFER_SIZE="${AX_DB_ROCKSDB_WRITE_BUFFER_SIZE:-33554432}"
ROCKSDB_MAX_WRITE_BUFFER_NUMBER="${AX_DB_ROCKSDB_MAX_WRITE_BUFFER_NUMBER:-4}"

mkdir -p "$DATA_DIR" "$LOG_DIR" "$BUCKETS_DIR/transcripts" "$BUCKETS_DIR/codex_artifacts"

if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  echo "[axctl] SurrealDB already on port $PORT" >&2
  exit 0
fi

# rocksdb file backend, daemonized
# --allow-experimental files: enables DEFINE BUCKET + f"bucket:/path" file syntax (SurrealDB 3.0)
# SURREAL_BUCKET_FOLDER_ALLOWLIST: required allowlist for file:// backed buckets
# RocksDB defaults scale with host RAM and can reserve tens of GB on developer machines.
SURREAL_BUCKET_FOLDER_ALLOWLIST="$BUCKETS_DIR" \
SURREAL_ROCKSDB_BLOCK_CACHE_SIZE="$ROCKSDB_BLOCK_CACHE_SIZE" \
SURREAL_ROCKSDB_WRITE_BUFFER_SIZE="$ROCKSDB_WRITE_BUFFER_SIZE" \
SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER="$ROCKSDB_MAX_WRITE_BUFFER_NUMBER" \
nohup surreal start \
  --user "$USER" --pass "$PASS" \
  --bind "127.0.0.1:$PORT" \
  --log info \
  --allow-experimental=files \
  "rocksdb://$DATA_DIR/db" \
  >>"$LOG_DIR/surreal.log" 2>&1 &

echo $! > "$DATA_DIR/surreal.pid"
sleep 1
if ! kill -0 "$(cat "$DATA_DIR/surreal.pid")" 2>/dev/null; then
  echo "[axctl] SurrealDB failed to stay running; see $LOG_DIR/surreal.log" >&2
  exit 1
fi
echo "[axctl] SurrealDB pid=$(cat "$DATA_DIR/surreal.pid") port=$PORT data=$DATA_DIR/db buckets=$BUCKETS_DIR rocksdb_cache=$ROCKSDB_BLOCK_CACHE_SIZE"
