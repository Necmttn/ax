/**
 * Build a REAL published DuckDB cache in a temp directory, for tests that must
 * read through the seam rather than around it.
 *
 * The whole point is that nothing is mocked: the fixture applies the REAL
 * `schema.duckdb.sql`, writes through `withCacheWrite` while genuinely HOLDING
 * the ingest lock (the seam refuses to open the live database otherwise - the
 * lock IS the write capability), builds the FTS indexes ingest builds, and
 * publishes a snapshot. Readers then get the same `CacheRead` service the CLI,
 * the HTTP handler and the MCP tools resolve.
 *
 * Lives under `src/` rather than in a single `.test.ts` because three suites
 * need it (`queries/repository-scope`, `cli/recall-no-surreal`, and any wave-2
 * port that follows the same template), and `check:no-node-fs` scans this tree -
 * so paths go through `Path.Path` and the caller supplies the temp directory
 * (test helpers own `mkdtemp`; see `@ax/lib/testing/duckdb-dylib`).
 */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { buildFtsIndexes } from "@ax/lib/duckdb/fts";
import { CacheReadLayer, withCacheWrite, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";

/** Bun-backed FileSystem + Path, the base every fixture effect needs. */
export const FixturePlatform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** Run a fixture effect, providing the platform layers. */
export const runWithPlatform = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(FixturePlatform)) as Effect.Effect<A, E>);

export interface CacheFixture {
    readonly dir: string;
    readonly livePath: string;
    readonly lockPath: string;
    readonly snapshotPath: string;
}

/**
 * Write `rows` into a fresh live database under `dir` and publish a snapshot.
 * `dylibPath` is the suite's resolved libduckdb (`null` = let the seam resolve
 * one, which is what a dylib-less box would do - such suites skip anyway).
 */
export const publishCacheFixture = (
    dir: string,
    dylibPath: string | null,
    rows: (write: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
): Effect.Effect<CacheFixture, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture: CacheFixture = {
            dir,
            livePath: path.join(dir, "live.duckdb"),
            lockPath: path.join(dir, "ingest.lock"),
            snapshotPath: path.join(dir, "snapshot.duckdb"),
        };

        yield* withIngestLock(
            {
                lockPath: fixture.lockPath,
                command: "cache-fixture",
                staleMs: 60_000,
                onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
            },
            withCacheWrite(
                {
                    livePath: fixture.livePath,
                    lockPath: fixture.lockPath,
                    snapshotPath: fixture.snapshotPath,
                    schemaSql: DUCKDB_SCHEMA_SQL,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                },
                (write) =>
                    Effect.gen(function* () {
                        yield* rows(write);
                        // FTS is a BUILD STEP, not DDL: the index must exist
                        // before any `match_bm25` call.
                        yield* buildFtsIndexes(write);
                    }),
            ),
        );

        return fixture;
    });

/** A `CacheRead` layer over a published fixture snapshot. */
export const readFixture = (snapshotPath: string, dylibPath: string | null) =>
    CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) });
