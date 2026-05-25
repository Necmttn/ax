#!/usr/bin/env bash
# Uninstall the axctl launchd weekly checkpoint agent.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "uninstall-checkpoint.sh: macOS only (launchd). Detected: $(uname -s)" >&2
  exit 1
fi

LABEL="com.necmttn.ax-checkpoint"
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
