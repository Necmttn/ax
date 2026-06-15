#!/usr/bin/env bash
set -euo pipefail

REPO="${AXCTL_REPO:-Necmttn/ax}"
VERSION="${AXCTL_VERSION:-latest}"
INSTALL_ROOT="${AXCTL_INSTALL_ROOT:-$HOME/.local/share/ax}"
BIN_DIR="${AXCTL_BIN_DIR:-$HOME/.local/bin}"
RUN_INSTALL="${AXCTL_RUN_INSTALL:-1}"
BINARY_PATH=""
MODIFY_PATH=1

# ---------------------------------------------------------------------------
# Pretty output. Colors auto-disable when stdout isn't a TTY, when NO_COLOR is
# set, or under a dumb terminal. `esc` is built with printf (not $'...') so it
# stays portable when the installer is run via `curl ... | sh`.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  esc=$(printf '\033')
  C_RESET="${esc}[0m"; C_BOLD="${esc}[1m"; C_DIM="${esc}[2m"
  C_GREEN="${esc}[32m"; C_YELLOW="${esc}[33m"; C_RED="${esc}[31m"
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

banner() {
  printf '%s%s' "$C_GREEN" "$C_BOLD"
  cat <<'ART'

   █████╗ ██╗  ██╗
  ██╔══██╗╚██╗██╔╝
  ███████║ ╚███╔╝
  ██╔══██║ ██╔██╗
  ██║  ██║██╔╝ ██╗
  ╚═╝  ╚═╝╚═╝  ╚═╝
ART
  printf '%s' "$C_RESET"
  printf '  %sthe agent experience layer%s\n' "$C_DIM" "$C_RESET"
  printf '  %slocal memory + telemetry for your coding agents%s\n\n' "$C_DIM" "$C_RESET"
}

step()  { printf '  %s▸%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

usage() {
  cat <<'EOF'
Install axctl from a GitHub Release artifact.

Usage: install.sh [options]

Options:
  -h, --help                Display this help message
  -v, --version VERSION     Install a specific release tag/version (for example v0.2.0)
  -b, --binary PATH         Install from a local binary instead of downloading
      --no-run-install      Only install the binary; skip `axctl install`
      --no-modify-path      Do not append PATH instructions to shell config files

Environment:
  AXCTL_REPO=owner/repo          GitHub repo to download from (default: Necmttn/ax)
  AXCTL_VERSION=v0.1.0           Release tag to install (default: latest)
  AXCTL_INSTALL_ROOT=path        Install root (default: ~/.local/share/ax)
  AXCTL_BIN_DIR=path             Symlink dir (default: ~/.local/bin)
  AXCTL_RUN_INSTALL=0            Only install the binary; skip `axctl install`
  NO_COLOR=1                     Disable colored output
  GH_TOKEN/GITHUB_TOKEN=token    Token for private repo downloads when gh is unavailable
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      if [[ -z "${2:-}" ]]; then
        err "--version requires a value"
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    -b|--binary)
      if [[ -z "${2:-}" ]]; then
        err "--binary requires a path"
        exit 2
      fi
      BINARY_PATH="$2"
      shift 2
      ;;
    --no-run-install)
      RUN_INSTALL=0
      shift
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    *)
      err "unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    exit 1
  fi
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      err "unsupported OS $(uname -s)"
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      err "unsupported architecture $(uname -m)"
      exit 1
      ;;
  esac

  printf "%s-%s" "$os" "$arch"
}

asset_url() {
  local asset="$1"
  if [[ "$VERSION" == "latest" ]]; then
    printf "https://github.com/%s/releases/latest/download/%s" "$REPO" "$asset"
  else
    printf "https://github.com/%s/releases/download/%s/%s" "$REPO" "$VERSION" "$asset"
  fi
}

download_with_gh() {
  local pattern="$1" out_dir="$2"
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  if [[ "$VERSION" == "latest" ]]; then
    gh release download --repo "$REPO" --pattern "$pattern" --dir "$out_dir" --clobber
  else
    gh release download "$VERSION" --repo "$REPO" --pattern "$pattern" --dir "$out_dir" --clobber
  fi
}

download_with_curl() {
  local asset="$1" out_path="$2"
  need curl

  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  local url
  url="$(asset_url "$asset")"

  if [[ -n "$token" ]]; then
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" "$url" -o "$out_path"
  else
    curl -fsSL "$url" -o "$out_path"
  fi
}

# ---------------------------------------------------------------------------
# Resilience against broken releases. If a release is published with missing
# binaries (e.g. one platform's build job failed, so `publish-artifacts` was
# skipped and the GitHub Release "latest" ended up with 0 assets), a plain
# `latest` install 404s for everyone. When VERSION=latest, resolve the newest
# release that actually carries the artifact we need and fall back to it.
# ---------------------------------------------------------------------------
# Newest-first release tags from the public releases API (works without `gh`).
# GitHub returns minified JSON, so pull the tag names with a tolerant grep.
fetch_release_tags() {
  command -v curl >/dev/null 2>&1 || return 1
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}" json
  if [[ -n "$token" ]]; then
    json="$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null)" || return 1
  else
    json="$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null)" || return 1
  fi
  printf '%s' "$json" | grep -oE '"tag_name":[[:space:]]*"[^"]+"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
}

# HTTP status for a release asset download (follows GitHub's redirect to the
# asset CDN). 200 means the artifact exists for that tag.
asset_http_code() {
  local tag="$1" asset="$2" token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  local url="https://github.com/$REPO/releases/download/$tag/$asset"
  if [[ -n "$token" ]]; then
    curl -sIL -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url" 2>/dev/null
  else
    curl -sIL -o /dev/null -w '%{http_code}' "$url" 2>/dev/null
  fi
}

# Mutates the global VERSION from "latest" to a concrete tag when the GitHub
# latest release is missing the artifact. No-op when latest is healthy, or when
# the release list can't be resolved (offline) - the existing download + error
# paths still apply. Prefers `gh` (handles private repos + minified JSON), and
# falls back to the public API + a per-tag asset probe when `gh` is absent.
resolve_latest_version() {
  local asset="$1" newest="" with_asset=""

  if command -v gh >/dev/null 2>&1; then
    newest="$(gh api "repos/$REPO/releases?per_page=30" \
      --jq 'first(.[].tag_name) // empty' 2>/dev/null || true)"
    with_asset="$(gh api "repos/$REPO/releases?per_page=30" \
      --jq 'first(.[] | select([.assets[].name] | index("'"$asset"'")) | .tag_name) // empty' 2>/dev/null || true)"
  fi

  if [[ -z "$with_asset" ]]; then
    local tags tag n=0
    tags="$(fetch_release_tags)" || return 0
    [[ -z "$tags" ]] && return 0
    [[ -z "$newest" ]] && newest="$(printf '%s\n' "$tags" | head -1)"
    while IFS= read -r tag; do
      [[ -z "$tag" ]] && continue
      n=$((n + 1))
      [[ "$n" -gt 12 ]] && break
      if [[ "$(asset_http_code "$tag" "$asset")" == "200" ]]; then
        with_asset="$tag"
        break
      fi
    done <<EOF
$tags
EOF
  fi

  [[ -z "$with_asset" ]] && return 0
  # Healthy latest: the newest release already carries the asset - leave
  # VERSION=latest so the install keeps using the /releases/latest path.
  if [[ -n "$newest" && "$with_asset" == "$newest" ]]; then
    return 0
  fi
  if [[ -n "$newest" ]]; then
    warn "latest release ${newest} is missing ${asset} (likely a broken release)"
  fi
  info "pinning to ${with_asset} - the newest release with a ${asset} build"
  VERSION="$with_asset"
}

banner

platform="$(detect_platform)"
artifact="axctl-${platform}.tar.gz"

# When asked for `latest`, pin to the newest release that actually ships our
# artifact so a partially-published release can't break the install.
if [[ -z "$BINARY_PATH" && "$VERSION" == "latest" ]]; then
  resolve_latest_version "$artifact"
fi

step "platform $C_BOLD${platform}$C_RESET · channel $C_BOLD${VERSION}$C_RESET"

if [[ -z "$BINARY_PATH" && "$VERSION" != "latest" && "$(command -v axctl || true)" != "" ]]; then
  installed="$(axctl --version 2>/dev/null || true)"
  if [[ "$installed" == "${VERSION#v}" || "$installed" == *"axctl ${VERSION#v}"* || "$installed" == *"axctl v${VERSION#v}"* ]]; then
    ok "version ${VERSION#v} already installed"
    exit 0
  fi
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

if [[ -n "$BINARY_PATH" ]]; then
  if [[ ! -f "$BINARY_PATH" ]]; then
    err "local binary not found: $BINARY_PATH"
    exit 1
  fi
  step "installing local binary"
  info "$BINARY_PATH"
else
  step "downloading ${artifact}"
  info "from ${REPO} (${VERSION})"

  if ! download_with_gh "$artifact" "$tmp_dir"; then
    if ! download_with_curl "$artifact" "$tmp_dir/$artifact"; then
      err "failed to download ${artifact}"
      cat >&2 <<EOF

  Pin to a known-good release if the latest one is missing binaries:
    AXCTL_VERSION=v0.28.0 curl -fsSL ax.necmttn.com/install | sh
    (releases: https://github.com/${REPO}/releases)

  For private repos, either:
    1. run 'gh auth login', or
    2. export GH_TOKEN or GITHUB_TOKEN with repo read access.

  If no release exists yet, run the Release Please workflow and merge the
  release PR first.
EOF
      exit 1
    fi
  fi

  if download_with_gh "checksums.txt" "$tmp_dir" >/dev/null 2>&1 || download_with_curl "checksums.txt" "$tmp_dir/checksums.txt" >/dev/null 2>&1; then
    checksum_line="$(
      cd "$tmp_dir"
      awk -v f="$artifact" '$2 == f || $2 == "./" f { print; found = 1; exit } END { if (!found) exit 1 }' checksums.txt
    )" || {
      err "checksums.txt did not include ${artifact}"
      exit 1
    }
    expected_sha="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
    actual_sha=""
    if command -v shasum >/dev/null 2>&1; then
      actual_sha="$(shasum -a 256 "$tmp_dir/$artifact" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
      actual_sha="$(sha256sum "$tmp_dir/$artifact" | awk '{print $1}')"
    fi
    if [[ -z "$actual_sha" ]]; then
      warn "no sha256 checker found, skipping verification"
    elif [[ "$actual_sha" == "$expected_sha" ]]; then
      ok "checksum verified"
    else
      err "checksum mismatch for ${C_BOLD}${artifact}${C_RESET}"
      printf '    %sexpected%s %s\n' "$C_DIM" "$C_RESET" "$expected_sha" >&2
      printf '    %sactual  %s %s\n' "$C_DIM" "$C_RESET" "$actual_sha" >&2
      printf '    %sthis usually means a broken release - please report at%s\n' "$C_DIM" "$C_RESET" >&2
      printf '    %shttps://github.com/%s/issues%s\n' "$C_BOLD" "$REPO" "$C_RESET" >&2
      exit 1
    fi
  else
    warn "checksums.txt not found, skipping verification"
  fi

  need tar
  tar -xzf "$tmp_dir/$artifact" -C "$tmp_dir"
fi

install_bin="$INSTALL_ROOT/bin/axctl"
mkdir -p "$INSTALL_ROOT/bin" "$BIN_DIR"
if [[ -n "$BINARY_PATH" ]]; then
  install -m 755 "$BINARY_PATH" "$install_bin"
else
  install -m 755 "$tmp_dir/axctl" "$install_bin"
fi
ln -sfn "$install_bin" "$BIN_DIR/axctl"
ln -sfn "$install_bin" "$BIN_DIR/ax"

ok "installed $C_BOLD${install_bin}$C_RESET"
info "$BIN_DIR/axctl → $install_bin"
info "$BIN_DIR/ax    → $install_bin  (alias)"

if [[ "$MODIFY_PATH" == "1" && ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not on your PATH"
  info "add it: export PATH=\"$BIN_DIR:\$PATH\""
fi

# `axctl install` chains into `axctl setup` (agent skills + first ingest +
# doctor). On non-macOS the daemon install is skipped, so point the user at
# `ax setup` directly (skills install works cross-platform).
RAN_SETUP=0
if [[ "$RUN_INSTALL" == "1" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf '\n'
    step "running ${C_BOLD}axctl install${C_RESET} (SurrealDB + watcher + ${C_BOLD}ax setup${C_RESET})"
    "$install_bin" install
    RAN_SETUP=1
  else
    printf '\n'
    warn "full daemon install is macOS-only for now; skipping 'axctl install'"
  fi
fi

# ---------------------------------------------------------------------------
# Done.
# ---------------------------------------------------------------------------
printf '\n'
if [[ "$RAN_SETUP" == "1" ]]; then
  printf '  %s%sax is ready.%s\n\n' "$C_GREEN" "$C_BOLD" "$C_RESET"
else
  printf '  %s%saxctl installed.%s next, finish setup:\n\n' "$C_GREEN" "$C_BOLD" "$C_RESET"
  printf '    %sax setup%s     %sinstall the agent skills + first ingest%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
fi
printf '    %sax doctor%s    %scheck your setup%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    %sax serve%s     %sopen the dashboard → http://127.0.0.1:1738%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
printf '    %sax recall%s    %ssearch what your agents actually did%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
printf '\n'

# When setup didn't auto-run (non-macOS / --no-run-install), surface the
# paste-into-your-agent prompt directly from the binary (single source of truth).
if [[ "$RAN_SETUP" != "1" ]]; then
  printf '  %s▸ then hand the rest to your agent - paste this into Claude Code or Codex:%s\n\n' "$C_BOLD" "$C_RESET"
  "$install_bin" setup --agent-prompt 2>/dev/null | sed 's/^/    /'
  printf '\n'
fi

printf '  %sdocs %shttps://ax.necmttn.com/docs%s\n\n' "$C_DIM" "$C_RESET" "$C_RESET"
