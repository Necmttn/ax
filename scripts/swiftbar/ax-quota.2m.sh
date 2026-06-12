#!/usr/bin/env bash
# <xbar.title>ax quota</xbar.title>
# <xbar.desc>Claude plan usage (5h/7d windows) in the menubar, via `ax quota`.</xbar.desc>
# <xbar.dependencies>axctl</xbar.dependencies>
#
# SwiftBar/xbar plugin. Install:
#   cp scripts/swiftbar/ax-quota.2m.sh "$(defaults read com.ameba.SwiftBar PluginDirectory)/"
#   chmod +x ".../ax-quota.2m.sh"
# The "2m" in the filename is the refresh cadence; the endpoint itself is
# only polled when the ax-side cache (default 60s TTL) has expired.
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

AX_BIN="$(command -v ax || command -v axctl || true)"
if [ -z "$AX_BIN" ]; then
    echo "◌ ax?"
    echo "---"
    echo "ax CLI not found on PATH | color=red"
    exit 0
fi

"$AX_BIN" quota --swiftbar --max-age=90
