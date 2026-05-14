#!/usr/bin/env bash
# Install + load the SurrealDB daemon as a launchd LaunchAgent.
set -euo pipefail

DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax}"
LOG_DIR="$DATA_DIR/logs"
BUCKETS_DIR="$DATA_DIR/buckets"
TEMPLATE="$(dirname "$0")/com.necmttn.ax-db.plist"
TARGET="$HOME/Library/LaunchAgents/com.necmttn.ax-db.plist"

mkdir -p "$DATA_DIR" "$LOG_DIR" "$BUCKETS_DIR/transcripts" "$BUCKETS_DIR/codex_artifacts"

if ! command -v surreal >/dev/null 2>&1; then
  echo "ERROR: surreal CLI not found. Install with: brew install surrealdb/tap/surreal" >&2
  exit 1
fi

# Render template
sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__DATA_DIR__|$DATA_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$TARGET"

# Idempotent unload then load
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"

echo "[axctl] daemon installed: $TARGET"
echo "[axctl] data: $DATA_DIR/db"
echo "[axctl] buckets: $BUCKETS_DIR"
echo "[axctl] logs: $LOG_DIR/{db.out,db.err}"

# Wait for the daemon to bind (max 5s)
for i in 1 2 3 4 5; do
  if lsof -iTCP:8521 -sTCP:LISTEN -nP >/dev/null 2>&1; then
    echo "[axctl] daemon listening on 127.0.0.1:8521"
    break
  fi
  sleep 1
done

# Apply schema if connection works
if lsof -iTCP:8521 -sTCP:LISTEN -nP >/dev/null 2>&1; then
  bash "$(dirname "$0")/apply-schema.sh"
else
  echo "[axctl] WARNING: daemon not yet listening; run 'bash scripts/apply-schema.sh' manually" >&2
fi
