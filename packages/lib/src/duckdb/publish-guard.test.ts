/**
 * The empty-publish backstop, against REAL databases.
 *
 * This must be an end-to-end test and not a unit test of a predicate, because
 * the property that matters is about a FILE ON DISK: after a run that would have
 * wiped the snapshot, is the snapshot still there with its rows in it? A mocked
 * guard can be correct while the publish still happens.
 *
 * The failure being prevented has hit a real store five times: the published
 * snapshot went to zero rows while the live database kept everything, and every
 * read afterwards answered "no data" with exit code 0.
 */
import { describe, expect } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "../ingest-lock.ts";
import { runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { withCacheWrite, CacheReadLayer, CacheRead, type CacheWriteService } from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("publish guard");

/** One ingest "run" against `dir`, publishing to `dir/snapshot.duckdb`. */
const asIngestRun = <A>(
    dir: string,
    liveName: string,
    body: (write: CacheWriteService) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
    runWithPlatform(
        Effect.gen(function* () {
            const path = yield* Path.Path;
            const lockPath = path.join(dir, "ingest.lock");
            const outcome = yield* withIngestLock(
                {
                    lockPath,
                    command: "publish-guard-test",
                    staleMs: 60_000,
                    onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
                },
                withCacheWrite(
                    {
                        livePath: path.join(dir, liveName),
                        lockPath,
                        snapshotPath: path.join(dir, "snapshot.duckdb"),
                        schemaSql: DUCKDB_SCHEMA_SQL,
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    },
                    body,
                ),
            );
            if (outcome._tag !== "completed") {
                throw new Error(`ingest run did not complete: ${outcome._tag}`);
            }
            return outcome.value;
        }) as Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
    );

/** Sessions visible in `dir/snapshot.duckdb` through the normal read seam. */
const snapshotSessions = (dir: string): Promise<number> =>
    runWithPlatform(
        Effect.gen(function* () {
            const read = yield* CacheRead;
            const result = yield* read.raw("SELECT CAST(count(*) AS DOUBLE) AS n FROM session");
            return Number(result.rows[0]?.n ?? 0);
        }).pipe(
            Effect.provide(
                CacheReadLayer({
                    snapshotPath: `${dir}/snapshot.duckdb`,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                }),
            ),
        ) as Effect.Effect<number, unknown, FileSystem.FileSystem | Path.Path>,
    );

const insertSession = (write: CacheWriteService, id: string) =>
    write.put("session", {
        id,
        source: "claude",
        started_at: new Date("2026-01-01T00:00:00Z"),
    });

describe("empty-publish guard", () => {
    dtest("refuses to replace a populated snapshot with an empty one", async () => {
        const dir = await tempDir("refuse");

        // Run 1: a real ingest that writes sessions and publishes them.
        await asIngestRun(dir, "live.duckdb", (write) => insertSession(write, "session-1"));
        expect(await snapshotSessions(dir)).toBe(1);

        // Run 2: a DIFFERENT, fresh live database - the shape that destroyed the
        // real store. It writes nothing and would publish its empty self over
        // the snapshot from run 1.
        await asIngestRun(dir, "other-live.duckdb", () => Effect.void);

        // The guard's whole purpose, stated as the user experiences it: the data
        // is still there.
        expect(await snapshotSessions(dir)).toBe(1);
    });

    dtest("still publishes normally when the incoming database has rows", async () => {
        const dir = await tempDir("allow");
        await asIngestRun(dir, "live.duckdb", (write) => insertSession(write, "session-1"));
        expect(await snapshotSessions(dir)).toBe(1);

        // The same live database, now with a second session: an ordinary
        // incremental run must publish exactly as before. A guard that blocked
        // this would be worse than the bug.
        await asIngestRun(dir, "live.duckdb", (write) => insertSession(write, "session-2"));
        expect(await snapshotSessions(dir)).toBe(2);
    });

    dtest("publishes an empty database when there is no snapshot to lose", async () => {
        const dir = await tempDir("first");
        // A first ingest that finds nothing to ingest is not a data-loss event,
        // and it must still produce a readable snapshot - otherwise every read
        // on a brand-new machine reports "no cache" instead of "no data yet".
        await asIngestRun(dir, "live.duckdb", () => Effect.void);
        expect(await snapshotSessions(dir)).toBe(0);
    });

    dtest("an explicit override still allows the empty publish", async () => {
        const dir = await tempDir("override");
        await asIngestRun(dir, "live.duckdb", (write) => insertSession(write, "session-1"));
        expect(await snapshotSessions(dir)).toBe(1);

        const saved = process.env.AX_ALLOW_EMPTY_PUBLISH;
        process.env.AX_ALLOW_EMPTY_PUBLISH = "1";
        try {
            await asIngestRun(dir, "other-live.duckdb", () => Effect.void);
            expect(await snapshotSessions(dir)).toBe(0);
        } finally {
            if (saved === undefined) delete process.env.AX_ALLOW_EMPTY_PUBLISH;
            else process.env.AX_ALLOW_EMPTY_PUBLISH = saved;
        }
    });
});
