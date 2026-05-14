#!/usr/bin/env bash
set -euo pipefail
PORT="${AX_DB_PORT:-${AGENTCTL_DB_PORT:-8521}}"
USER="${AX_DB_USER:-${AGENTCTL_DB_USER:-root}}"
PASS="${AX_DB_PASS:-${AGENTCTL_DB_PASS:-root}}"
NS="${AX_DB_NS:-ax}"
DB="${AX_DB_DB:-main}"
SCHEMA="$(dirname "$0")/../schema/schema.surql"

# Bucket paths are hardcoded in schema.surql to /Users/necmttn/.local/share/ax/buckets/*
# because SurrealQL does not expand env vars. Warn if the runtime data dir differs.
DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
HARDCODED_DATA_DIR="/Users/necmttn/.local/share/ax"
if [ "$DATA_DIR" != "$HARDCODED_DATA_DIR" ]; then
  echo "[axctl] WARNING: AX_DATA_DIR=$DATA_DIR but schema buckets point at $HARDCODED_DATA_DIR" >&2
  echo "[axctl] WARNING: edit schema/schema.surql DEFINE BUCKET BACKEND paths to match, or unset AX_DATA_DIR" >&2
fi

surreal import \
  --endpoint "http://127.0.0.1:$PORT" \
  --user "$USER" --pass "$PASS" \
  --ns "$NS" --db "$DB" \
  "$SCHEMA"
echo "[axctl] schema applied to $NS/$DB"
