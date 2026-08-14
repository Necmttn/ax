#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_root=${DUCKDB_BUILD_ROOT:-"$repo_root/dist/duckdb-build"}
source_dir="$build_root/src"
dist_dir=${DUCKDB_DIST_DIR:-"$repo_root/dist/duckdb"}
config_template="$repo_root/scripts/duckdb-spike/static-build/extension_config_local.cmake"
# Pinned to the v1.5.5 tag's commit sha, not the tag name - a tag can be
# force-moved on the remote, and a cached checkout could silently drift onto
# a re-tagged commit without this. Resolve a new sha with:
#   git ls-remote --tags https://github.com/duckdb/duckdb.git v1.5.5
duckdb_pinned_sha=d8cdaa33fda8df955cc76ef58a280f68f4cd43fa

# Cleanup for every smoke_home mktemp dir created below. A per-function
# `trap ... RETURN` never fires when `set -e` aborts the script mid-function
# (only on a normal return), so temp HOME dirs from a failed smoke test were
# left behind. A single EXIT trap over an accumulated list fires on every
# exit path - success, `return 1`, or a `set -e` abort - and still cleans up
# a dir from an earlier smoke_* call even after a later call overwrites the
# trap registration.
smoke_tmp_dirs=()
cleanup_smoke_tmp_dirs() {
    local dir
    for dir in "${smoke_tmp_dirs[@]}"; do
        rm -rf "$dir"
    done
}
trap cleanup_smoke_tmp_dirs EXIT

smoke_duckdb() {
    local shell_bin=$1
    local smoke_home
    local smoke_output
    smoke_home=$(mktemp -d "${TMPDIR:-/tmp}/ax-duckdb-smoke.XXXXXX")
    smoke_tmp_dirs+=("$smoke_home")

    if ! smoke_output=$(
        HOME="$smoke_home" \
        HTTP_PROXY=http://127.0.0.1:9 \
        HTTPS_PROXY=http://127.0.0.1:9 \
        ALL_PROXY=http://127.0.0.1:9 \
        NO_PROXY='' \
        "$shell_bin" -batch -noheader -list <<'SQL'
.bail on
SET autoinstall_known_extensions=false;
SET autoload_known_extensions=false;
SET custom_extension_repository='';
LOAD fts;
LOAD json;
CREATE TABLE documents (id INTEGER, body VARCHAR);
INSERT INTO documents VALUES (1, 'hello static world'), (2, 'unrelated text');
PRAGMA create_fts_index('documents', 'id', 'body', overwrite=1);
SELECT 'fts=' || id::VARCHAR || ':' || body
FROM documents
WHERE fts_main_documents.match_bm25(id, 'static') IS NOT NULL;
SELECT 'json=' || json_extract('{"answer":42}', '$.answer')::VARCHAR;
SQL
    ); then
        printf '%s\n' "$smoke_output" >&2
        echo "DuckDB air-gap smoke failed" >&2
        return 1
    fi

    printf '%s\n' "$smoke_output"
    grep -Fxq 'fts=1:hello static world' <<<"$smoke_output"
    grep -Fxq 'json=42' <<<"$smoke_output"
    echo "DuckDB air-gap smoke passed"
}

smoke_duckdb_dylib() {
    local dylib_path=$1
    local smoke_home
    smoke_home=$(mktemp -d "${TMPDIR:-/tmp}/ax-duckdb-dylib-smoke.XXXXXX")
    smoke_tmp_dirs+=("$smoke_home")

    HOME="$smoke_home" \
    HTTP_PROXY=http://127.0.0.1:9 \
    HTTPS_PROXY=http://127.0.0.1:9 \
    ALL_PROXY=http://127.0.0.1:9 \
    NO_PROXY='' \
        bun "$repo_root/scripts/smoke-duckdb-dylib.ts" "$dylib_path"
}

if [[ ${1:-} == "--smoke-only" ]]; then
    if [[ $# -ne 2 ]]; then
        echo "usage: $0 --smoke-only <duckdb-shell>" >&2
        exit 2
    fi
    smoke_duckdb "$2"
    exit 0
fi

if [[ $# -ne 0 ]]; then
    echo "usage: $0 [--smoke-only <duckdb-shell>]" >&2
    exit 2
fi

mkdir -p "$build_root" "$dist_dir"
if [[ -d "$source_dir" && ! -d "$source_dir/.git" ]]; then
    echo "removing stale non-git checkout at $source_dir" >&2
    rm -rf "$source_dir"
fi
if [[ ! -d "$source_dir/.git" ]]; then
    git clone --depth 1 --branch v1.5.5 https://github.com/duckdb/duckdb.git "$source_dir"
fi

source_head=$(git -C "$source_dir" rev-parse HEAD)
if [[ "$source_head" != "$duckdb_pinned_sha" ]]; then
    echo "$source_dir HEAD ($source_head) does not match the pinned DuckDB v1.5.5 commit ($duckdb_pinned_sha)" >&2
    exit 1
fi

cp "$config_template" "$source_dir/extension/extension_config_local.cmake"
# STATIC_LIBCPP=1 statically links libstdc++/libc++ into the DuckDB build so
# the produced binaries don't depend on the runner's system C++ runtime -
# needed on the Linux matrix legs (glibc/libstdc++ version skew between the
# build runner and wherever the artifact ships). Passed through only when the
# caller sets it (e.g. the workflow's `static_libcpp` matrix entry); omitted
# entirely otherwise so local/macOS builds are unaffected.
# shellcheck disable=SC2086
GEN=ninja CORE_EXTENSIONS='json' EXTENSION_STATIC_BUILD=1 ${STATIC_LIBCPP:+STATIC_LIBCPP=$STATIC_LIBCPP} make -C "$source_dir"

case $(uname -s) in
    Darwin) library_name=libduckdb.dylib ;;
    Linux) library_name=libduckdb.so ;;
    *)
        echo "unsupported platform: $(uname -s)" >&2
        exit 1
        ;;
esac

cp "$source_dir/build/release/src/$library_name" "$dist_dir/$library_name"
cp "$source_dir/build/release/duckdb" "$dist_dir/duckdb"
chmod +x "$dist_dir/duckdb"

smoke_duckdb "$dist_dir/duckdb"
smoke_duckdb_dylib "$dist_dir/$library_name"
echo "DuckDB artifacts: $dist_dir/$library_name and $dist_dir/duckdb"
