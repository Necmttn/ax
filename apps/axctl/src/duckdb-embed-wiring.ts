/**
 * Apps-side DuckDB embed wiring: threads this binary's embedded dylib
 * (`duckdb-embed.gen.ts`, baked in by `scripts/build-axctl.ts` via
 * `scripts/gen-duckdb-embed.ts`) into `@ax/lib/duckdb/seam`'s construction
 * points.
 *
 * `packages/lib` cannot import from `apps/axctl`, so `CacheReadLive` /
 * `withCacheWrite` built with no `assetPath` can only ever resolve libduckdb
 * via `AX_DUCKDB_DYLIB` or `dist/duckdb/` on disk - neither exists inside a
 * compiled binary's `$bunfs` virtual filesystem. `DuckDbLiveOptions.assetPath`
 * is the seam that lets this apps-side module hand the embed in instead - see
 * `duckdb-embed.gen.ts`'s header (#791, wave 3 c-binary-embed).
 *
 * Every apps-side call site that previously imported the bare `CacheReadLive`
 * from `@ax/lib/duckdb/seam`, or built a `withCacheWrite`/`withConfigWrite`
 * options object without an `assetPath`, imports/spreads from here instead -
 * `CacheReadLive` for the read side, `duckdbAssetPathOption()` for the write
 * side (`apps/axctl/src/ingest/run.ts`, `apps/axctl/src/cli/commands/ingest.ts`,
 * `apps/axctl/src/config-core/reconcile.ts`) - so a `dist/axctl` build with no
 * `dist/duckdb`, no `vendor/duckdb`, and no `AX_DUCKDB_DYLIB` still opens (and
 * writes) the cache. In source mode `DUCKDB_DYLIB` is the committed stub
 * (`undefined`), so `resolveDylibPath` falls through to `AX_DUCKDB_DYLIB` /
 * `dist/duckdb/` exactly as before - this module changes nothing about
 * `bun run` behaviour.
 */
import { CacheReadLayer } from "@ax/lib/duckdb/seam";
import { DUCKDB_DYLIB, DUCKDB_NODE_BINDING } from "./duckdb-embed.gen.ts";

/**
 * `{ assetPath: DUCKDB_DYLIB, nodeBindingAssetPath: DUCKDB_NODE_BINDING }`
 * when the embed produced them, `{}` otherwise -
 * `exactOptionalPropertyTypes` treats an explicit `assetPath: undefined` as a
 * different (rejected) shape than an omitted key, so every call site that
 * threads `DUCKDB_DYLIB` into a `DuckDbLiveOptions`-shaped object spreads this
 * instead of assigning the constant directly. Mirrors the identical
 * `options?.assetPath === undefined ? {} : { assetPath: ... }` guard already
 * used inside `@ax/lib/duckdb/seam`. `DUCKDB_NODE_BINDING` (#880) is the napi
 * driver's `duckdb.node` addon, staged next to the dylib by
 * `@ax/lib/duckdb`'s binding loader in a compiled binary.
 */
export const duckdbAssetPathOption = (): Record<never, never> | {
    readonly assetPath: string;
    readonly nodeBindingAssetPath?: string;
} =>
    DUCKDB_DYLIB === undefined
        ? {}
        : {
              assetPath: DUCKDB_DYLIB,
              ...(DUCKDB_NODE_BINDING === undefined
                  ? {}
                  : { nodeBindingAssetPath: DUCKDB_NODE_BINDING }),
          };

export const CacheReadLive = CacheReadLayer({ ...duckdbAssetPathOption() });
