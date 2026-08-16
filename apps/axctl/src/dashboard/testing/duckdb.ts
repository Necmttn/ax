import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Path } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { CacheReadLayer, withCacheWrite, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

export interface DashboardDuckDbFixture {
    readonly snapshotPath: string;
    readonly assetPath?: string;
}

export const publishDashboardFixture = <A>(
    dir: string,
    dylibPath: string | null,
    write: (db: CacheWriteService) => Effect.Effect<A, unknown>,
): Promise<DashboardDuckDbFixture> => {
    const effect = Effect.gen(function* () {
        const path = yield* Path.Path;
        const livePath = path.join(dir, "live.duckdb");
        const snapshotPath = path.join(dir, "snapshot.duckdb");
        const lockPath = path.join(dir, "ingest.lock");
        const asset = dylibPath === null ? {} : { assetPath: dylibPath };
        yield* withIngestLock(
            { lockPath, command: "dashboard-test", staleMs: 60_000, onBusy: () => Effect.die("test ingest lock was busy") },
            withCacheWrite({ livePath, snapshotPath, lockPath, schemaSql: DUCKDB_SCHEMA_SQL, ...asset }, write),
        );
        return { snapshotPath, ...asset };
    });
    return Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<DashboardDuckDbFixture, unknown>);
};

export const runDashboardRead = <A>(
    fixture: DashboardDuckDbFixture,
    effect: Effect.Effect<A, unknown, import("@ax/lib/duckdb/seam").CacheRead>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(CacheReadLayer(fixture))) as Effect.Effect<A, unknown>);
