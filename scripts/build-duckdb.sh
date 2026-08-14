#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_root=${DUCKDB_BUILD_ROOT:-"$repo_root/dist/duckdb-build"}
source_dir="$build_root/src"
dist_dir=${DUCKDB_DIST_DIR:-"$repo_root/dist/duckdb"}
config_template="$repo_root/scripts/duckdb-spike/static-build/extension_config_local.cmake"

smoke_duckdb() {
    local shell_bin=$1
    local smoke_home
    local smoke_output
    smoke_home=$(mktemp -d "${TMPDIR:-/tmp}/ax-duckdb-smoke.XXXXXX")
    trap 'rm -rf "$smoke_home"' RETURN

    if ! smoke_output=$(
        HOME="$smoke_home" \
        HTTP_PROXY=http://127.0.0.1:9 \
        HTTPS_PROXY=http://127.0.0.1:9 \
        ALL_PROXY=http://127.0.0.1:9 \
        NO_PROXY='' \
        "$shell_bin" -batch -noheader -list <<'SQL'
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
    trap 'rm -rf "$smoke_home"' RETURN

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
if [[ ! -d "$source_dir/.git" ]]; then
    git clone --depth 1 --branch v1.5.5 https://github.com/duckdb/duckdb.git "$source_dir"
fi

if [[ $(git -C "$source_dir" describe --tags --exact-match 2>/dev/null || true) != "v1.5.5" ]]; then
    echo "$source_dir is not a DuckDB v1.5.5 checkout" >&2
    exit 1
fi

cp "$config_template" "$source_dir/extension/extension_config_local.cmake"
GEN=ninja CORE_EXTENSIONS='json' EXTENSION_STATIC_BUILD=1 make -C "$source_dir"

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
