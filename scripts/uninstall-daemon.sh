#!/usr/bin/env bash
set -euo pipefail
TARGET="$HOME/Library/LaunchAgents/com.necmttn.agentctl-db.plist"
if [ -f "$TARGET" ]; then
  launchctl unload "$TARGET" 2>/dev/null || true
  rm -f "$TARGET"
  echo "[agentctl] daemon uninstalled"
else
  echo "[agentctl] daemon not installed"
fi
