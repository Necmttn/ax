#!/usr/bin/env bash
set -euo pipefail
PORT="${AGENTCTL_DB_PORT:-8521}"
USER="${AGENTCTL_DB_USER:-root}"
PASS="${AGENTCTL_DB_PASS:-root}"
NS="${AGENTCTL_DB_NS:-agentctl}"
DB="${AGENTCTL_DB_DB:-main}"
SCHEMA="$(dirname "$0")/../schema/schema.surql"
surreal import \
  --endpoint "http://127.0.0.1:$PORT" \
  --user "$USER" --pass "$PASS" \
  --ns "$NS" --db "$DB" \
  "$SCHEMA"
echo "[agentctl] schema applied to $NS/$DB"
