#!/usr/bin/env bash
# trace-ingest.sh - run an instrumented ingest with spans exported to a local
# Maple collector (https://maple.dev/local/), for flame-graph profiling.
#
#   scripts/trace-ingest.sh [--stages=claude] [--since=1] [...any ax ingest args]
#
# Requires: `brew install Makisuo/tap/maple`. Starts maple detached if the
# OTLP port is not already listening. Inspect with `maple traces` or the UI
# the startup banner prints (local.maple.dev).
#
# Tip: pause the watcher first so samples are not contended:
#   launchctl bootout gui/$UID/com.necmttn.ax-watch
#   ... profile ...
#   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.necmttn.ax-watch.plist
set -euo pipefail

OTLP_URL="${AX_OTLP_URL:-http://127.0.0.1:4318}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v maple >/dev/null 2>&1; then
    echo "maple not installed: brew install Makisuo/tap/maple" >&2
    exit 1
fi

if ! curl -sf -o /dev/null --max-time 1 "${OTLP_URL}/v1/traces" -X POST -H 'content-type: application/json' -d '{}'; then
    echo "starting maple (detached, logs ~/.maple/maple.log)..." >&2
    maple start -d
    sleep 1
fi

echo "exporting to ${OTLP_URL} (service: axctl)" >&2
exec env AX_OTLP_URL="${OTLP_URL}" AX_PROGRESS="${AX_PROGRESS:-off}" \
    bun "${REPO_ROOT}/apps/axctl/src/cli/index.ts" ingest "$@"
