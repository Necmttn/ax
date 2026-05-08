#!/usr/bin/env bash
set -euo pipefail
PORT="${AGENTCTL_DB_PORT:-8521}"
USER="${AGENTCTL_DB_USER:-root}"
PASS="${AGENTCTL_DB_PASS:-root}"
NS="${AGENTCTL_DB_NS:-agentctl}"
DB="${AGENTCTL_DB_DB:-main}"
SCHEMA="$(dirname "$0")/../schema/schema.surql"

# Bucket paths are hardcoded in schema.surql to /Users/necmttn/.local/share/agentctl/buckets/*
# because SurrealQL does not expand env vars. Warn if the runtime data dir differs.
DATA_DIR="${AGENTCTL_DATA_DIR:-$HOME/.local/share/agentctl}"
HARDCODED_DATA_DIR="/Users/necmttn/.local/share/agentctl"
if [ "$DATA_DIR" != "$HARDCODED_DATA_DIR" ]; then
  echo "[agentctl] WARNING: AGENTCTL_DATA_DIR=$DATA_DIR but schema buckets point at $HARDCODED_DATA_DIR" >&2
  echo "[agentctl] WARNING: edit schema/schema.surql DEFINE BUCKET BACKEND paths to match, or unset AGENTCTL_DATA_DIR" >&2
fi

surreal import \
  --endpoint "http://127.0.0.1:$PORT" \
  --user "$USER" --pass "$PASS" \
  --ns "$NS" --db "$DB" \
  "$SCHEMA"
echo "[agentctl] schema applied to $NS/$DB"
