#!/usr/bin/env bash
# Uninstall the agentctl launchd WatchPaths agent.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "uninstall-watcher.sh: macOS only (launchd). Detected: $(uname -s)" >&2
  exit 1
fi

LABEL="com.necmttn.agentctl-watch"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl list | grep -q "$LABEL"; then
  echo "Unloading $LABEL..."
  launchctl unload -w "$TARGET" 2>/dev/null || true
fi

if [[ -f "$TARGET" ]]; then
  rm -f "$TARGET"
  echo "Removed: $TARGET"
else
  echo "No plist at $TARGET (already uninstalled)."
fi
