#!/usr/bin/env bash
set -euo pipefail
PORT="${AX_DB_PORT:-8521}"
USER="${AX_DB_USER:-root}"
PASS="${AX_DB_PASS:-root}"
NS="${AX_DB_NS:-ax}"
DB="${AX_DB_DB:-main}"
SCHEMA="$(dirname "$0")/../packages/schema/src/schema.surql"

# Bucket BACKEND paths in schema.surql carry the committing machine's absolute
# path (SurrealQL cannot expand env vars). Rewrite them to THIS machine's
# buckets dir before import - a mismatched path is denied by the daemon's
# SURREAL_BUCKET_FOLDER_ALLOWLIST and rolls back the whole import (issue #251).
# Mirrors renderBucketBackends in packages/schema/src/render.ts.
DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
BUCKETS_DIR="$DATA_DIR/buckets"
RENDERED="$(mktemp -t ax-schema.XXXXXX.surql)"
trap 'rm -f "$RENDERED"' EXIT
sed -E "s|BACKEND \"file:[^\"]*/buckets/([a-zA-Z0-9_]+)\"|BACKEND \"file:$BUCKETS_DIR/\1\"|" \
  "$SCHEMA" > "$RENDERED"

surreal import \
  --endpoint "http://127.0.0.1:$PORT" \
  --user "$USER" --pass "$PASS" \
  --ns "$NS" --db "$DB" \
  "$RENDERED"
echo "[axctl] schema applied to $NS/$DB (buckets at $BUCKETS_DIR)"
