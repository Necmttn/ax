/**
 * `reviewed` is a CACHE edge whose retro moved to the SIDECAR, so the only
 * writer it can have is an ingest-time re-derive. These cases run the real
 * thing: a real temp DuckDB cache, a real temp SQLite sidecar, and the writer
 * called with the lock-held `CacheWriteService` the ingest stage hands it.
 */
import { describe, expect } from "bun:test";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { JudgmentLayer } from "@ax/lib/sqlite";
import { edgeRowId } from "@ax/lib/stable-id";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { retroRecordKey, syncReviewedEdges, upsertRetro } from "./retro.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("reviewed edges", { requireFts: true });

const ReviewedRow = Schema.Struct({
    id: Schema.String,
    in_id: Schema.String,
    out_id: Schema.String,
});

interface Outcome {
    readonly firstWritten: number;
    readonly secondWritten: number;
    readonly rows: ReadonlyArray<typeof ReviewedRow.Type>;
}

const runFixture = (): Promise<Outcome> => {
    const dir = tempDir("ax-reviewed-edges-");
    const judgmentLayer = JudgmentLayer({
        sidecarPath: join(dir, "judgment.sqlite"),
        schemaSql: SIDECAR_SCHEMA_SQL,
    }).pipe(Layer.provide(FixturePlatform));

    return runWithPlatform(Effect.gen(function* () {
        let outcome: Outcome | undefined;
        yield* publishCacheFixture(dir, dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("session", [
                    { id: "kept", source: "claude", started_at: new Date() },
                ]);
                // Two retros, ONE of which points at a session the cache no
                // longer holds - the edge must not be written for that one.
                yield* upsertRetro({
                    sessionId: "kept",
                    source: "manual",
                    payload: { tried: "1 turn(s)", worked: null, failed: null, next: null },
                });
                yield* upsertRetro({
                    sessionId: "session:purged",
                    source: "manual",
                    payload: { tried: "9 turn(s)", worked: null, failed: null, next: null },
                });

                const firstWritten = yield* syncReviewedEdges(write);
                // Re-derive: the natural key is (in, out), so a second pass
                // must not double the row count.
                const secondWritten = yield* syncReviewedEdges(write);
                const rows = yield* write.rows(
                    ReviewedRow,
                    "SELECT id, in_id, out_id FROM reviewed ORDER BY in_id",
                );
                outcome = { firstWritten, secondWritten, rows };
            }).pipe(Effect.provide(judgmentLayer), Effect.scoped));
        if (outcome === undefined) return yield* Effect.die("fixture body did not run");
        return outcome;
    }));
};

describe("syncReviewedEdges", () => {
    dtest("writes one edge per sidecar retro whose session is still cached", async () => {
        const outcome = await runFixture();
        expect(outcome.firstWritten).toBe(1);
        expect(outcome.rows).toHaveLength(1);
        const row = outcome.rows[0]!;
        expect(row.in_id).toBe("kept");
        expect(row.out_id).toBe(retroRecordKey("kept"));
        expect(row.id).toBe(edgeRowId("reviewed", "kept", retroRecordKey("kept")));
    });

    dtest("re-deriving is idempotent", async () => {
        const outcome = await runFixture();
        expect(outcome.secondWritten).toBe(outcome.firstWritten);
        expect(outcome.rows).toHaveLength(1);
    });
});
