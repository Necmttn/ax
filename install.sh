#!/usr/bin/env bash
set -euo pipefail

REPO="${AXCTL_REPO:-${AGENTCTL_REPO:-Necmttn/ax}}"
VERSION="${AXCTL_VERSION:-${AGENTCTL_VERSION:-latest}}"
INSTALL_ROOT="${AXCTL_INSTALL_ROOT:-${AGENTCTL_INSTALL_ROOT:-$HOME/.local/share/ax}}"
BIN_DIR="${AXCTL_BIN_DIR:-${AGENTCTL_BIN_DIR:-$HOME/.local/bin}}"
RUN_INSTALL="${AXCTL_RUN_INSTALL:-${AGENTCTL_RUN_INSTALL:-1}}"
BINARY_PATH=""
MODIFY_PATH=1

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
        echo "axctl install: --version requires a value" >&2
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    -b|--binary)
      if [[ -z "${2:-}" ]]; then
        echo "axctl install: --binary requires a path" >&2
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
      echo "axctl install: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "axctl install: missing required command: $1" >&2
    exit 1
  fi
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      echo "axctl install: unsupported OS $(uname -s)" >&2
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      echo "axctl install: unsupported architecture $(uname -m)" >&2
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

platform="$(detect_platform)"
artifact="axctl-${platform}.tar.gz"

if [[ -z "$BINARY_PATH" && "$VERSION" != "latest" && "$(command -v axctl || command -v agentctl || true)" != "" ]]; then
  installed="$({ axctl --version || agentctl --version; } 2>/dev/null || true)"
  if [[ "$installed" == "${VERSION#v}" || "$installed" == *"axctl ${VERSION#v}"* || "$installed" == *"agentctl ${VERSION#v}"* || "$installed" == *"axctl v${VERSION#v}"* || "$installed" == *"agentctl v${VERSION#v}"* ]]; then
    echo "[axctl] version ${VERSION#v} already installed"
    exit 0
  fi
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

if [[ -n "$BINARY_PATH" ]]; then
  if [[ ! -f "$BINARY_PATH" ]]; then
    echo "axctl install: local binary not found: $BINARY_PATH" >&2
    exit 1
  fi
  echo "[axctl] installing local binary: $BINARY_PATH"
else
  echo "[axctl] downloading ${artifact} from ${REPO} (${VERSION})"

  if ! download_with_gh "$artifact" "$tmp_dir"; then
    if ! download_with_curl "$artifact" "$tmp_dir/$artifact"; then
      cat >&2 <<EOF
axctl install: failed to download ${artifact}

For private repos, either:
  1. run 'gh auth login', or
  2. export GH_TOKEN or GITHUB_TOKEN with repo read access.

If no release exists yet, run the Release Please workflow and merge the release PR first.
EOF
      exit 1
    fi
  fi

  if download_with_gh "checksums.txt" "$tmp_dir" >/dev/null 2>&1 || download_with_curl "checksums.txt" "$tmp_dir/checksums.txt" >/dev/null 2>&1; then
    checksum_line="$(
      cd "$tmp_dir"
      awk -v f="$artifact" '$2 == f || $2 == "./" f { print; found = 1; exit } END { if (!found) exit 1 }' checksums.txt
    )" || {
      echo "[axctl] checksums.txt did not include ${artifact}" >&2
      exit 1
    }
    if command -v shasum >/dev/null 2>&1; then
      (cd "$tmp_dir" && printf '%s\n' "$checksum_line" | shasum -a 256 -c -)
    elif command -v sha256sum >/dev/null 2>&1; then
      (cd "$tmp_dir" && printf '%s\n' "$checksum_line" | sha256sum -c -)
    else
      echo "[axctl] checksum file downloaded; no sha256 checker found, skipping verification"
    fi
  else
    echo "[axctl] checksums.txt not found; skipping checksum verification"
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
ln -sfn "$install_bin" "$BIN_DIR/agentctl"

echo "[axctl] installed binary: $install_bin"
echo "[axctl] symlink: $BIN_DIR/axctl -> $install_bin"
echo "[axctl] alias symlink: $BIN_DIR/ax -> $install_bin"
echo "[axctl] legacy symlink: $BIN_DIR/agentctl -> $install_bin"

if [[ "$MODIFY_PATH" == "1" && ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "[axctl] add this to PATH if needed: export PATH=\"$BIN_DIR:\$PATH\""
fi

if [[ "$RUN_INSTALL" == "1" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$install_bin" install
  else
    echo "[axctl] binary installed. Full daemon install is currently macOS-only; skipping axctl install."
  fi
fi
