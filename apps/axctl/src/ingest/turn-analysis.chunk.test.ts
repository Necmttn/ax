/**
 * `deriveTurnAnalysis` now fetches turns one SESSION CHUNK at a time and
 * writes each chunk's `turn_analysis`/`expresses`/`reacts_to` rows before
 * fetching the next (#917): a single unbounded `SELECT ... FROM turn` (full
 * `text` column) was one of the fetches behind the ~14 GB RSS segfault on a
 * full `--reparse=claude` backfill.
 *
 * The one piece of state that genuinely spans chunks is the `semantic_signal`
 * firstSeen/lastSeen/confidence merge: a signal key (kind + label) is not
 * session-scoped, so the SAME key can recur in a later chunk and must widen
 * the earlier chunk's window rather than being overwritten by it (an
 * `INSERT OR REPLACE` per chunk would silently lose that history). This
 * suite pins, against a REAL DuckDB with an injected small `batchSize`:
 *
 *  - every session is visited and every turn is counted exactly once
 *  - a signal spanning the FIRST and LAST chunk still merges to the true
 *    firstSeen/lastSeen/confidence, not just the last chunk that touched it
 *  - the persisted `turn_analysis`/`semantic_signal`/`expresses`/`reacts_to`
 *    rows are identical whether derived in one chunk or many
 *  - a second (incremental) run over the same store is a no-op (idempotence)
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveTurnAnalysis, semanticSignalKey, type TurnAnalysisStats } from "./turn-analysis.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("turn analysis chunking", { requireFts: true });

// Small injected batch size so the fixture crosses two chunk boundaries
// (3 + 3 + 1) without seeding hundreds of fixture rows.
const BATCH_SIZE = 3;
const SESSION_COUNT = 7;
const RECENT = new Date("2026-01-15T00:00:00.000Z");
const EARLY = new Date("2020-01-01T00:00:00.000Z");
const LATE = new Date("2030-01-01T00:00:00.000Z");
const STOP_DOING_KEY = semanticSignalKey("correction", "stop_doing");

/**
 * Every session gets an assistant turn followed by a user turn. The FIRST
 * session (chunk 1) and the LAST session (chunk 3, past the boundary) both
 * carry a "stop_doing" correction - same signal key, different timestamps -
 * so the derive's cross-chunk signal merge is exercised, not just its
 * per-chunk row counting.
 */
const seedSessionsAndTurns = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
            id: `s${String(i).padStart(4, "0")}`,
            source: "claude",
            started_at: RECENT,
        }));
        yield* write.putMany("session", sessions);

        const turns = sessions.flatMap((s, i) => {
            const isFirst = i === 0;
            const isLast = i === SESSION_COUNT - 1;
            const userTs = isFirst ? EARLY : isLast ? LATE : RECENT;
            const userText = isFirst || isLast ? "stop doing that" : `please look at src/${s.id}.ts`;
            const userIntentKind = isFirst || isLast ? "correction" : "organic_task";
            return [
                {
                    id: `${s.id}-t0`, session: s.id, seq: 1n, ts: RECENT, role: "assistant",
                    message_kind: "assistant", intent_kind: null, text: "Implemented the fix.", text_excerpt: "Implemented the fix.",
                },
                {
                    id: `${s.id}-t1`, session: s.id, seq: 2n, ts: userTs, role: "user",
                    message_kind: "task", intent_kind: userIntentKind, text: userText, text_excerpt: userText,
                },
            ];
        });
        yield* write.putMany("turn", turns);
    });

const AnalysisRow = Schema.Struct({
    id: Schema.String, turn: Schema.String, session: Schema.NullOr(Schema.String), speaker: Schema.String,
    act: Schema.String, sentiment: Schema.String, polarity: Schema.String, confidence: Schema.Number,
    signals: Schema.NullOr(Schema.String),
});
const SignalRow = Schema.Struct({
    id: Schema.String, kind: Schema.String, label: Schema.String, confidence: Schema.Number,
    first_seen: Schema.NullOr(Schema.Date), last_seen: Schema.NullOr(Schema.Date),
});
const ExpressesRow = Schema.Struct({
    id: Schema.String, in_id: Schema.String, out_id: Schema.String, session: Schema.NullOr(Schema.String),
    confidence: Schema.Number,
});
const ReactsToRow = Schema.Struct({
    id: Schema.String, in_id: Schema.String, out_id: Schema.String, session: Schema.NullOr(Schema.String),
    polarity: Schema.String, act: Schema.String, signal: Schema.NullOr(Schema.String),
});

const projectAnalysisRows = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const analyses = yield* write.rows(AnalysisRow, "SELECT id, turn, session, speaker, act, sentiment, polarity, confidence, signals FROM turn_analysis ORDER BY id");
        const signals = yield* write.rows(SignalRow, "SELECT id, kind, label, confidence, first_seen, last_seen FROM semantic_signal ORDER BY id");
        const expresses = yield* write.rows(ExpressesRow, "SELECT id, in_id, out_id, session, confidence FROM expresses ORDER BY id");
        const reactsTo = yield* write.rows(ReactsToRow, "SELECT id, in_id, out_id, session, polarity, act, signal FROM reacts_to ORDER BY id");
        return { analyses, signals, expresses, reactsTo };
    });

interface AnalysisRows {
    readonly analyses: readonly Schema.Schema.Type<typeof AnalysisRow>[];
    readonly signals: readonly Schema.Schema.Type<typeof SignalRow>[];
    readonly expresses: readonly Schema.Schema.Type<typeof ExpressesRow>[];
    readonly reactsTo: readonly Schema.Schema.Type<typeof ReactsToRow>[];
}

interface Run {
    readonly stats: TurnAnalysisStats;
    readonly rows: AnalysisRows;
}

const runFixture = (dirPrefix: string, batchSize: number): Promise<Run> =>
    runWithPlatform(Effect.gen(function* () {
        let result: Run | undefined;
        yield* publishCacheFixture(tempDir(dirPrefix), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* seedSessionsAndTurns(write);
                const stats = yield* deriveTurnAnalysis(write, { sinceDays: undefined, batchSize });
                const rows = yield* projectAnalysisRows(write);
                result = { stats, rows };
            }));
        if (result === undefined) return yield* Effect.die("fixture body did not run");
        return result;
    }));

describe("deriveTurnAnalysis session chunking (#917)", () => {
    dtest("visits every session and sums every turn across chunk boundaries", async () => {
        const run = await runFixture("ax-turn-analysis-chunk-", BATCH_SIZE);
        expect(run.stats.turnsAnalyzed).toBe(SESSION_COUNT * 2);
        expect(run.rows.analyses).toHaveLength(SESSION_COUNT * 2);
    });

    dtest("a signal spanning the first and last chunk merges firstSeen/lastSeen, not just the last chunk", async () => {
        const run = await runFixture("ax-turn-analysis-signal-span-", BATCH_SIZE);
        const stopDoing = run.rows.signals.find((s) => s.id === STOP_DOING_KEY);
        expect(stopDoing).toBeDefined();
        expect(stopDoing?.first_seen?.toISOString()).toBe(EARLY.toISOString());
        expect(stopDoing?.last_seen?.toISOString()).toBe(LATE.toISOString());
    });

    dtest("chunked and single-batch derives persist identical analysis rows", async () => {
        const chunked = await runFixture("ax-turn-analysis-chunked-", BATCH_SIZE);
        const single = await runFixture("ax-turn-analysis-single-", SESSION_COUNT * 10);

        expect(chunked.stats).toEqual(single.stats);
        expect(chunked.rows.analyses).toEqual(single.rows.analyses);
        expect(chunked.rows.signals).toEqual(single.rows.signals);
        expect(chunked.rows.expresses).toEqual(single.rows.expresses);
        expect(chunked.rows.reactsTo).toEqual(single.rows.reactsTo);
    });

    dtest("a second incremental run over the same store is a no-op", async () => {
        const dir = tempDir("ax-turn-analysis-idempotent-");
        const runs = await runWithPlatform(Effect.gen(function* () {
            let first: TurnAnalysisStats | undefined;
            let second: TurnAnalysisStats | undefined;
            yield* publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* seedSessionsAndTurns(write);
                    first = yield* deriveTurnAnalysis(write, { sinceDays: undefined, batchSize: BATCH_SIZE });
                    second = yield* deriveTurnAnalysis(write, { sinceDays: undefined, batchSize: BATCH_SIZE });
                }));
            if (first === undefined || second === undefined) return yield* Effect.die("fixture body did not run");
            return { first, second };
        }));

        expect(runs.first.turnsAnalyzed).toBe(SESSION_COUNT * 2);
        expect(runs.second.turnsAnalyzed).toBe(0);
        expect(runs.second.expressesEdges).toBe(0);
        expect(runs.second.reactsToEdges).toBe(0);
        // Signals are re-derived (in memory) from an empty `analyses` set on
        // the no-op run, so the accumulator is empty and nothing is promoted
        // - the persisted rows from the first run stay untouched (no DELETE).
        expect(runs.second.signalsPromoted).toBe(0);
    });
});
