/**
 * #1084: a cache written by a pre-#1055 axctl already has
 * `cache_bust_event.corroborated_cost_usd` plus its two secondary indexes
 * (`cache_bust_event_ts`, `cache_bust_event_session_seq`). The current DDL's
 * `ALTER TABLE cache_bust_event DROP COLUMN IF EXISTS corroborated_cost_usd`
 * ran on EVERY write-connection open (`withCacheWrite` applies `schemaSql`
 * unconditionally), and `ts` sits after `corroborated_cost_usd` in column
 * order - so DuckDB refused the ALTER while either index still existed, and
 * bricked every DB-backed command against an upgraded cache.
 *
 * Real database only, on purpose: the property under test is "does the DDL
 * apply cleanly against an old ON-DISK shape", which a text-only parse of
 * schema.duckdb.sql cannot see.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "../ingest-lock.ts";
import { runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { withCacheWrite, type CacheWriteError, type CacheWriteService } from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache_bust_event upgrade");

/** The pre-#1055 on-disk shape: `corroborated_cost_usd` plus both indexes,
 *  exactly as an axctl before that PR would have left it. Minimal - just
 *  enough of the real table for the ALTER/DROP INDEX interaction under test. */
const OLD_CACHE_BUST_EVENT_DDL = `
CREATE TABLE IF NOT EXISTS cache_bust_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,
    turn VARCHAR NOT NULL,
    seq BIGINT NOT NULL,
    source VARCHAR NOT NULL,
    model VARCHAR,
    reason VARCHAR NOT NULL,
    attribution_skill VARCHAR,
    attribution_agent VARCHAR,
    cache_creation_input_tokens BIGINT,
    bust_cost_usd DOUBLE,
    corroborated_cost_usd DOUBLE,
    ts TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_bust_event_ts ON cache_bust_event(ts);
CREATE INDEX IF NOT EXISTS cache_bust_event_session_seq ON cache_bust_event(session, seq);
`;

interface Paths {
    readonly dir: string;
    readonly livePath: string;
    readonly lockPath: string;
}

const paths = (prefix: string): Paths => {
    const dir = tempDir(prefix);
    return { dir, livePath: `${dir}/live.duckdb`, lockPath: `${dir}/ingest.lock` };
};

/** Open the live db under the ingest lock and apply `schemaSql`, then run
 *  `body`. `schemaSql: null` skips DDL application, mirroring the seam's own
 *  `withCacheWrite` contract (see `CacheWriteOptions.schemaSql`). */
const openWith = <A>(
    p: Paths,
    schemaSql: string | null,
    body: (write: CacheWriteService) => Effect.Effect<A, CacheWriteError, never>,
): Promise<A> =>
    runWithPlatform(
        Effect.gen(function* () {
            const outcome = yield* withIngestLock(
                {
                    lockPath: p.lockPath,
                    command: "cache-bust-event-upgrade-test",
                    staleMs: 60_000,
                    onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
                },
                withCacheWrite(
                    {
                        livePath: p.livePath,
                        lockPath: p.lockPath,
                        // No snapshot publish needed - these cases only assert
                        // against the live database the DDL was applied to.
                        publish: false,
                        schemaSql,
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    },
                    body,
                ),
            );
            if (outcome._tag !== "completed") {
                throw new Error(`ingest run did not complete: ${outcome._tag}`);
            }
            return outcome.value;
        }),
    );

describe("schema upgrade: cache_bust_event column removal vs pre-existing indexes (#1084)", () => {
    dtest("the full DDL applies cleanly against a pre-#1055 on-disk shape, preserving rows", async () => {
        const p = paths("ax-cache-bust-upgrade-");

        // Build the OLD shape and seed a sentinel row, exactly as an
        // already-ingested cache would have it.
        await openWith(p, OLD_CACHE_BUST_EVENT_DDL, (write) =>
            write.exec(
                "INSERT INTO cache_bust_event (id, session, turn, seq, source, reason, corroborated_cost_usd, ts) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ["sentinel-1", "session-1", "turn-1", 1, "claude", "cache_miss_expired", 0.42, new Date()],
            ),
        );

        // Upgrading: open the SAME live database with the CURRENT full DDL.
        // This must not throw the "index depends on a column after it" Catalog
        // Error every other DB-backed command hit on an upgraded cache.
        const rows = await openWith(p, DUCKDB_SCHEMA_SQL, (write) =>
            write.raw(
                "SELECT id, session, bust_cost_usd, ts FROM cache_bust_event WHERE id = 'sentinel-1'",
            ),
        );

        // The dropped column is gone from the live schema...
        expect(rows.rows.length).toBe(1);
        expect(rows.rows[0]?.["session"]).toBe("session-1");
        expect("corroborated_cost_usd" in (rows.rows[0] ?? {})).toBe(false);

        // ...and the two secondary indexes exist again, recreated.
        const indexes = await openWith(p, null, (write) =>
            write.raw(
                "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cache_bust_event' ORDER BY index_name",
            ),
        );
        expect(indexes.rows.map((r) => r["index_name"])).toEqual([
            "cache_bust_event_session_seq",
            "cache_bust_event_ts",
        ]);

        // A second application of the full DDL against the now-upgraded
        // database must also succeed (idempotency) and must not lose the row.
        const second = await openWith(p, DUCKDB_SCHEMA_SQL, (write) =>
            write.raw("SELECT count(*) AS n FROM cache_bust_event WHERE id = 'sentinel-1'"),
        );
        expect(Number(second.rows[0]?.["n"])).toBe(1);
    });
});
