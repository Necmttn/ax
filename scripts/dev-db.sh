#!/usr/bin/env bash
# dev-db.sh - manage a DISPOSABLE SurrealDB for `ax-dev`.
#
# Fully isolated from the stable ax DB: its own port (default 8522) and data dir
# (default ~/.local/share/ax-dev). No launchd agent - it runs on demand and you
# can wipe it any time. Invoked as `ax-dev db [start|--reset|stop|status]`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export AX_DATA_DIR="${AX_DATA_DIR:-$HOME/.local/share/ax-dev}"
# Keep the bind port in sync with AX_DB_URL (the shim exports ws://...:<port>).
if [ -z "${AX_DB_PORT:-}" ] && [ -n "${AX_DB_URL:-}" ]; then
    AX_DB_PORT="$(printf '%s' "$AX_DB_URL" | sed -nE 's#.*:([0-9]+).*#\1#p')"
fi
export AX_DB_PORT="${AX_DB_PORT:-8522}"

NS="${AX_DB_NS:-ax}"
DB="${AX_DB_DB:-main}"
DB_USER="${AX_DB_USER:-root}"
DB_PASS="${AX_DB_PASS:-root}"

# Prefer the version-matched surreal the stable install already vendored.
if [ -z "${AX_SURREAL_BIN:-}" ] && [ -x "$HOME/.local/share/ax/bin/surreal" ]; then
    export AX_SURREAL_BIN="$HOME/.local/share/ax/bin/surreal"
fi
SURREAL_BIN="${AX_SURREAL_BIN:-$(command -v surreal || true)}"

healthy() { curl -fsS "http://127.0.0.1:$AX_DB_PORT/health" >/dev/null 2>&1; }

apply_schema() {
    # Delegates to apply-schema.sh, which rewrites the committed DEFINE BUCKET
    # paths to $AX_DATA_DIR/buckets before import (issue #251) - one rewrite
    # implementation instead of a drifting copy here. AX_DATA_DIR/AX_DB_PORT
    # are already exported above; pass the rest explicitly.
    AX_SURREAL_BIN="$SURREAL_BIN" AX_DB_USER="$DB_USER" AX_DB_PASS="$DB_PASS" \
        AX_DB_NS="$NS" AX_DB_DB="$DB" \
        "$ROOT/scripts/apply-schema.sh"
}

stop_db() {
    local pidfile="$AX_DATA_DIR/surreal.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        kill "$(cat "$pidfile")" 2>/dev/null || true
        echo "[ax-dev] stopped dev SurrealDB (pid $(cat "$pidfile"))"
    else
        lsof -tiTCP:"$AX_DB_PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
    fi
    rm -f "$pidfile"
}

cmd="${1:-start}"
case "$cmd" in
    start | "")
        if healthy; then
            echo "[ax-dev] SurrealDB already running on :$AX_DB_PORT (data $AX_DATA_DIR/db)"
            exit 0
        fi
        bash "$ROOT/scripts/db-start.sh"
        apply_schema
        ;;
    --reset | reset)
        stop_db
        rm -rf "$AX_DATA_DIR/db"
        echo "[ax-dev] wiped $AX_DATA_DIR/db"
        bash "$ROOT/scripts/db-start.sh"
        apply_schema
        ;;
    stop | --stop)
        stop_db
        ;;
    status)
        if healthy; then
            echo "[ax-dev] SurrealDB healthy on :$AX_DB_PORT (data $AX_DATA_DIR/db)"
        else
            echo "[ax-dev] SurrealDB not running on :$AX_DB_PORT"
            exit 1
        fi
        ;;
    *)
        echo "usage: ax-dev db [start|--reset|stop|status]" >&2
        exit 2
        ;;
esac
