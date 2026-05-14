#!/usr/bin/env bash
set -euo pipefail
TARGET="$HOME/Library/LaunchAgents/com.necmttn.ax-db.plist"
if [ -f "$TARGET" ]; then
  launchctl unload "$TARGET" 2>/dev/null || true
  rm -f "$TARGET"
  echo "[axctl] daemon uninstalled"
else
  echo "[axctl] daemon not installed"
fi
