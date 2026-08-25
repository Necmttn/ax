/**
 * The signals derive fetches turns one SESSION CHUNK at a time (#1021): a
 * single unbounded fetch of all turns materialised the whole corpus in the Bun
 * VM heap and segfaulted the stage at ~12 GB on a full backfill. This suite
 * pins the property that MUST survive chunking: processing N sessions in
 * batches of {@link SESSION_BATCH_SIZE} visits every session and sums every
 * turn exactly once - a dropped or double-counted chunk boundary fails here.
 *
 * It seeds MORE than one batch of sessions so the loop crosses at least one
 * boundary, and derives against a REAL DuckDB (the same fixture harness the
 * window suite uses).
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveSignals, SESSION_BATCH_SIZE, type DeriveStats } from "./derive-signals.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derive signals chunking", { requireFts: true });

// One batch plus a remainder, so the derive crosses a chunk boundary and the
// last chunk is a short one - the two cases a boundary bug hits.
const SESSION_COUNT = SESSION_BATCH_SIZE + 7;
const TURNS_PER_SESSION = 2;
const RECENT = new Date();

const runFixture = (): Promise<DeriveStats> =>
    runWithPlatform(Effect.gen(function* () {
        let stats: DeriveStats | undefined;
        yield* publishCacheFixture(tempDir("ax-signals-chunk-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
                    id: `s${String(i).padStart(4, "0")}`,
                    source: "claude",
                    started_at: RECENT,
                }));
                yield* write.putMany("session", sessions);
                const turns = sessions.flatMap((s) =>
                    Array.from({ length: TURNS_PER_SESSION }, (_, seq) => ({
                        id: `${s.id}-t${seq}`,
                        session: s.id,
                        seq: BigInt(seq + 1),
                        ts: RECENT,
                        role: seq === 0 ? "user" : "assistant",
                        text_excerpt: "work",
                    })));
                yield* write.putMany("turn", turns);
                stats = yield* deriveSignals(write, {}).pipe(Effect.provide(BunFileSystem.layer));
            }));
        if (stats === undefined) return yield* Effect.die("fixture body did not run");
        return stats;
    }));

describe("deriveSignals session chunking (#1021)", () => {
    dtest("visits every session and sums every turn across chunk boundaries", async () => {
        const stats = await runFixture();
        expect(stats.sessions).toBe(SESSION_COUNT);
        expect(stats.turns).toBe(SESSION_COUNT * TURNS_PER_SESSION);
    });
});
