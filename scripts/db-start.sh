#!/usr/bin/env bash
# Start dedicated axctl SurrealDB instance.
set -euo pipefail

DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
LOG_DIR="$DATA_DIR/logs"
BUCKETS_DIR="$DATA_DIR/buckets"
PORT="${AX_DB_PORT:-8521}"
USER="${AX_DB_USER:-root}"
PASS="${AX_DB_PASS:-root}"
ROCKSDB_BLOCK_CACHE_SIZE="${AX_DB_ROCKSDB_BLOCK_CACHE_SIZE:-268435456}"
ROCKSDB_WRITE_BUFFER_SIZE="${AX_DB_ROCKSDB_WRITE_BUFFER_SIZE:-33554432}"
ROCKSDB_MAX_WRITE_BUFFER_NUMBER="${AX_DB_ROCKSDB_MAX_WRITE_BUFFER_NUMBER:-4}"

mkdir -p "$DATA_DIR" "$LOG_DIR" "$BUCKETS_DIR/transcripts" "$BUCKETS_DIR/codex_artifacts"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${AX_SURREAL_BIN:-}" ]; then
  SURREAL_BIN="$AX_SURREAL_BIN"
elif [ -x "$ROOT/result/bin/surreal" ]; then
  SURREAL_BIN="$ROOT/result/bin/surreal"
elif command -v nix >/dev/null 2>&1; then
  SURREAL_BIN="$(nix build --no-link --print-out-paths "$ROOT#surrealdb")/bin/surreal"
else
  SURREAL_BIN="$(command -v surreal)"
fi

SURREAL_VERSION="$("$SURREAL_BIN" version | awk '{print $1}')"
if [ "$SURREAL_VERSION" != "3.1.0" ]; then
  echo "[axctl] WARNING: starting SurrealDB $SURREAL_VERSION via $SURREAL_BIN; expected 3.1.0" >&2
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  echo "[axctl] SurrealDB already on port $PORT" >&2
  exit 0
fi

# rocksdb file backend
# --allow-experimental files: enables DEFINE BUCKET + f"bucket:/path" file syntax (SurrealDB 3.0)
# SURREAL_BUCKET_FOLDER_ALLOWLIST: required allowlist for file:// backed buckets
# RocksDB defaults scale with host RAM and can reserve tens of GB on developer machines.
export SURREAL_BUCKET_FOLDER_ALLOWLIST="$BUCKETS_DIR"
export SURREAL_ROCKSDB_BLOCK_CACHE_SIZE="$ROCKSDB_BLOCK_CACHE_SIZE"
export SURREAL_ROCKSDB_WRITE_BUFFER_SIZE="$ROCKSDB_WRITE_BUFFER_SIZE"
export SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER="$ROCKSDB_MAX_WRITE_BUFFER_NUMBER"

if [ "${AX_DB_FOREGROUND:-0}" = "1" ]; then
  echo "[axctl] starting SurrealDB $SURREAL_VERSION in foreground bin=$SURREAL_BIN port=$PORT data=$DATA_DIR/db buckets=$BUCKETS_DIR" >&2
  exec "$SURREAL_BIN" start \
    --user "$USER" --pass "$PASS" \
    --bind "127.0.0.1:$PORT" \
    --log info \
    --allow-experimental=files \
    "rocksdb://$DATA_DIR/db"
fi

nohup "$SURREAL_BIN" start \
  --user "$USER" --pass "$PASS" \
  --bind "127.0.0.1:$PORT" \
  --log info \
  --allow-experimental=files \
  "rocksdb://$DATA_DIR/db" \
  >>"$LOG_DIR/surreal.log" 2>&1 &

echo $! > "$DATA_DIR/surreal.pid"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$(cat "$DATA_DIR/surreal.pid")" 2>/dev/null; then
    echo "[axctl] SurrealDB failed to stay running; see $LOG_DIR/surreal.log" >&2
    exit 1
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[axctl] SurrealDB did not become healthy on port $PORT; see $LOG_DIR/surreal.log" >&2
  exit 1
fi
echo "[axctl] SurrealDB $SURREAL_VERSION pid=$(cat "$DATA_DIR/surreal.pid") port=$PORT bin=$SURREAL_BIN data=$DATA_DIR/db buckets=$BUCKETS_DIR rocksdb_cache=$ROCKSDB_BLOCK_CACHE_SIZE"
