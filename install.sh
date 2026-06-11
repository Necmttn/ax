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

banner

platform="$(detect_platform)"
artifact="axctl-${platform}.tar.gz"
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
