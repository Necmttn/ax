#!/usr/bin/env bash
# Install the launchd WatchPaths agent that runs `agentctl ingest --since=1`
# whenever ~/.claude/projects/ or ~/.codex/sessions/ change. macOS only.
#
# Idempotent: unloads any existing agent before reloading.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-watcher.sh: macOS only (launchd). Detected: $(uname -s)" >&2
  exit 1
fi

LABEL="com.necmttn.agentctl-watch"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TARGET="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/.local/share/agentctl/logs"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-watcher.sh: template not found: $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

# Render template (substitute __HOME__, __AGENTCTL_DIR__, __LOG_DIR__).
sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__AGENTCTL_DIR__|$REPO_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$TARGET"

# Unload first if already loaded (idempotent reload).
if launchctl list | grep -q "$LABEL"; then
  echo "Unloading existing $LABEL..."
  launchctl unload -w "$TARGET" 2>/dev/null || true
fi

echo "Loading $LABEL from $TARGET..."
launchctl load -w "$TARGET"

echo
echo "Installed: $TARGET"
echo "Logs:      $LOG_DIR/{watcher.log,watcher.out,watcher.err}"
echo "Verify:    launchctl list | grep $LABEL"
echo "Uninstall: bash $SCRIPT_DIR/uninstall-watcher.sh"
