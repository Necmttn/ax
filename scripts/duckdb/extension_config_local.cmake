# Local override (gitignored by duckdb itself - see .gitignore:348) that makes
# the `fts` extension link STATICALLY into libduckdb instead of the upstream
# CI default (.github/config/extensions/fts.cmake), which passes DONT_LINK
# because fts is now an out-of-tree extension (moved out of extension/fts/
# to github.com/duckdb/duckdb-fts). This file is picked up automatically by
# extension/extension_build_tools.cmake's "Local extension config" step,
# which runs BEFORE the BUILD_EXTENSIONS loop resolves "fts" against
# .github/config/extensions/fts.cmake - so as long as "fts" is NOT also
# listed in CORE_EXTENSIONS/BUILD_EXTENSIONS, this registration wins
# (duckdb_extension_load ignores an extension name it has already seen).
#
# GIT_TAG pinned to the same commit DuckDB's own CI uses for this release
# (.github/config/extensions/fts.cmake), just without DONT_LINK.
#
# INCLUDE_DIR override: duckdb_extension_load's default for an external
# (GIT_URL) extension is "<fetched-repo>/src/include" (the newer
# extension-ci-tools template layout). duckdb-fts still uses the OLD in-tree
# layout ("<fetched-repo>/extension/fts/include/fts_extension.hpp"), so
# without this override the codegen's generated_extension_headers.hpp
# (#include "fts_extension.hpp") fails with "file not found" even though the
# extension's own .cpp files compile fine (they don't go through this -I).
duckdb_extension_load(fts
    LOAD_TESTS
    GIT_URL https://github.com/duckdb/duckdb-fts
    GIT_TAG 6814ec9a7d5fd63500176507262b0dbf7cea0095
    INCLUDE_DIR extension/fts/include
    TEST_DIR test/sql
)
