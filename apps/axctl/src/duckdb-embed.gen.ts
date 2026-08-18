// AUTO-GENERATED stub - replaced during a custom DuckDB embed build
// (scripts/build-axctl.ts -> scripts/gen-duckdb-embed.ts writeManifest()),
// then restored to this stub afterwards so source builds and `bun test` do
// not require a platform-specific library.
//
// Wiring (#791, wave 3 c-binary-embed): `packages/lib` cannot import from
// `apps/axctl` (this file), so every apps-side consumer that reads the
// published DuckDB snapshot threads this value in as `assetPath` instead of
// reaching for a bare `DuckDbLive` - see `apps/axctl/src/duckdb-embed-wiring.ts`
// (the shared `CacheReadLive` wired via `CacheReadLayer({ assetPath:
// DUCKDB_DYLIB })`, and `duckdbAssetPathOption()` for the
// `withCacheWrite`/`withConfigWrite` call sites in
// `apps/axctl/src/ingest/run.ts`, `apps/axctl/src/cli/commands/ingest.ts`, and
// `apps/axctl/src/config-core/reconcile.ts`).
//
// DUCKDB_NODE_BINDING (#880): the napi driver's `duckdb.node` addon, embedded
// the same way so a compiled binary can stage it next to the dylib
// (`@ax/lib/duckdb`'s binding.ts). Threads through as
// `nodeBindingAssetPath`.
export const DUCKDB_DYLIB: string | undefined = undefined;
export const DUCKDB_NODE_BINDING: string | undefined = undefined;
