#!/usr/bin/env bash
# Install the launchd weekly agent that runs the experiment-loop checkpoint
# pass: first refreshes opportunities, then computes any due checkpoints
# (t+7 / t+30 / t+90 windows since experiment.created_at).
#
# Plan ref: docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md (Phase C9)
# Idempotent: unloads any existing agent before reloading.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-checkpoint.sh: macOS only (launchd). Detected: $(uname -s)" >&2
  exit 1
fi

LABEL="com.necmttn.ax-checkpoint"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TARGET="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/.local/share/ax/logs"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-checkpoint.sh: template not found: $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__AX_DIR__|$REPO_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$TARGET"

if launchctl list | grep -q "$LABEL"; then
  echo "Unloading existing $LABEL..."
  launchctl unload -w "$TARGET" 2>/dev/null || true
fi

echo "Loading $LABEL from $TARGET..."
launchctl load -w "$TARGET"

echo
echo "Installed: $TARGET"
echo "Schedule:  Mondays at 09:05 local time"
echo "Logs:      $LOG_DIR/{checkpoint.log,checkpoint.out,checkpoint.err}"
echo "Manual:    bun src/cli/index.ts improve checkpoint"
echo "Verify:    launchctl list | grep $LABEL"
echo "Uninstall: bash $SCRIPT_DIR/uninstall-checkpoint.sh"
