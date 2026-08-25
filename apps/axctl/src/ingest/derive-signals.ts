import { Effect, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { edgeRowId } from "@ax/lib/stable-id";
import {
    deriveCorrections, deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections, deriveFrictionFromToolCalls,
    correctedInvokedTurnKeys, deriveProposed, deriveRecovered, deriveSkillPairs,
    groupTurnsBySession, shouldDeriveAllTimeSkillPairs,
} from "./signals/core.ts";
import type {
    CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent, ProposedEdge, RecoveryEdge,
    SessionTurns, SkillPairAccum, ToolCallLike,
} from "./signals/types.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

// Derivation rules live in ./signals/core.ts (pure, fixture-tested by
// signals/core.test.ts); this file is stage wiring only: SELECTs, the
// per-bundle progress loop, statement building + chunked execution.

/**
 * How many sessions' turns one `fetchSessionTurnsForIds` round-trip pulls.
 *
 * A single unbounded fetch of ALL turns (with the `->invoked->skill` join
 * fanned out per turn) materialised the whole ~1M-row set in the Bun VM heap
 * at once - the derive stage then segfaulted at ~12 GB RSS on a full backfill
 * (#1021). Chunking by SESSION bounds the JS-side working set to O(batch): a
 * chunk holds every turn of at most this many sessions, and because
 * `groupTurnsBySession` only needs a session's turns to be contiguous, every
 * bundle a chunk yields is complete. The cross-chunk accumulators
 * (`pairsAccum`, `correctionBatch`, ...) live in `deriveSignals`, so partial
 * chunks still sum to the same result the single fetch produced.
 */
export const SESSION_BATCH_SIZE = 200;

/** Group an ordered id list into fixed-size chunks. */
const chunk = <A>(items: ReadonlyArray<A>, size: number): A[][] => {
    const out: A[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

/** Turn `ts > now - N days`, or "" for a full backfill. Interpolated (not
 *  bound) to match the rest of the ingest SQL; `Math.trunc` keeps it numeric. */
const turnSinceClause = (sinceDays: number | undefined, prefix: string): string =>
    sinceDays && sinceDays > 0
        ? `${prefix} t.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '${Math.trunc(sinceDays)} days'`
        : "";

/**
 * Every session id that has at least one in-window turn, ordered so the chunks
 * are stable run to run. This is the cheap first pass: one column, no join
 * fan-out, so even a 1M-turn store returns a bounded id list.
 */
const fetchSessionIds = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<string[], CacheWriteError> =>
    Effect.gen(function* () {
        const sql = `
SELECT DISTINCT t.session AS session
FROM turn t JOIN session s ON s.id = t.session
${turnSinceClause(sinceDays, "WHERE")}
ORDER BY t.session ASC`;
        const rows = yield* write.rows(Schema.Struct({ session: Schema.String }), sql);
        return rows.map((r) => r.session);
    });

/**
 * Fetch the (session → turns) bundles for a bounded set of session ids. Each
 * turn carries its outgoing `->invoked->skill.name` array so we can detect
 * "proposed but not invoked" without a second query. Same window filter as the
 * id pass, so a session partially in-window contributes only its in-window
 * turns - exactly what the old single fetch did.
 */
const fetchSessionTurnsForIds = (
    write: CacheWriteService,
    sessionIds: ReadonlyArray<string>,
    sinceDays: number | undefined,
): Effect.Effect<SessionTurns[], CacheWriteError> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return [];
        const placeholders = sessionIds.map(() => "?").join(", ");
        const sql = `
SELECT
    t.id, t.session, t.seq, t.role, t.text_excerpt, t.ts, t.has_error,
    s.repository, s.checkout, s.cwd,
    COALESCE(to_json(list(DISTINCT sk.name) FILTER (WHERE sk.name IS NOT NULL))::VARCHAR, '[]') AS invoked_skills
FROM turn t JOIN session s ON s.id = t.session
LEFT JOIN invoked i ON i.in_id = t.id LEFT JOIN skill sk ON sk.id = i.out_id
WHERE t.session IN (${placeholders}) ${turnSinceClause(sinceDays, "AND")}
GROUP BY t.id, t.session, t.seq, t.role, t.text_excerpt, t.ts, t.has_error, s.repository, s.checkout, s.cwd
ORDER BY t.session ASC, t.seq ASC`;
        const rows = yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: NumberFromBigIntColumn, role: Schema.String,
            text_excerpt: Schema.NullOr(Schema.String), ts: TimestampColumn, has_error: Schema.Boolean,
            repository: Schema.NullOr(Schema.String), checkout: Schema.NullOr(Schema.String),
            cwd: Schema.NullOr(Schema.String), invoked_skills: Schema.String,
        }), sql, [...sessionIds]);
        const mapped = rows.map((row) => ({
            id: row.id, session: row.session, seq: row.seq, role: row.role,
            text_excerpt: row.text_excerpt ?? undefined, ts: row.ts, has_error: row.has_error,
            ...(row.repository === null ? {} : { repository: row.repository }),
            ...(row.checkout === null ? {} : { checkout: row.checkout }),
            ...(row.cwd === null ? {} : { cwd: row.cwd }),
            invoked_skills: (JSON.parse(row.invoked_skills) as string[]).map((name) => SkillName.make(name)),
        }));
        return groupTurnsBySession(mapped);
    });

const fetchSkillNames = (write: CacheWriteService): Effect.Effect<SkillName[], CacheWriteError> =>
    Effect.gen(function* () {
        const result = yield* write.rows(Schema.Struct({ name: Schema.String }), "SELECT name FROM skill");
        // The skill table is the persisted catalog, i.e. a true producer of
        // canonical skill names - brand at this read boundary.
        return result
            .map((r) => r.name)
            .filter((n): n is string => Boolean(n))
            .map((n) => SkillName.make(n));
    });

/**
 * Fetch the error `tool_call` rows for a bounded set of session ids - the
 * same session-chunking `fetchSessionTurnsForIds` applies to turns (#1021),
 * extended to cover this SEPARATE, previously-unbounded materialisation
 * (#1043). Past ~60-90 days of history the single unbounded `WHERE
 * tc.has_error = true` fetch (17 columns, including the `output_excerpt` /
 * `error_text` text columns, for EVERY error in the window) crossed a
 * threshold that segfaulted the DuckDB->JS bridge at ~2.5 GB RSS. Bounding by
 * `tc.session IN (...)` caps each round-trip to at most one chunk's worth of
 * sessions' errors.
 *
 * `sinceDays` stays as a second filter even though `sessionIds` is already
 * window-derived from `fetchSessionIds`: a session can carry both an
 * in-window turn (which puts it in the id list) and an out-of-window tool
 * call, and a windowed derive must still skip that old call - pinned by
 * `derive-signals.window.test.ts`. Keeping it is strictly cheaper than
 * dropping it (an extra indexed predicate vs. pulling rows this stage would
 * then have to discard).
 */
const fetchFailedToolCalls = (
    write: CacheWriteService,
    sessionIds: ReadonlyArray<string>,
    sinceDays: number | undefined,
): Effect.Effect<ToolCallLike[], CacheWriteError> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return [];
        const placeholders = sessionIds.map(() => "?").join(", ");
        const sinceFilter = sinceDays && sinceDays > 0 ? `AND tc.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '${Math.trunc(sinceDays)} days'` : "";
        const sql = `
SELECT
    tc.id, tc.session, tc.turn, tc.name, tc.ts, tc.status, tc.command_norm,
    tc.output_excerpt, tc.error_text, tc.exit_code, tc.duration_ms, tc.has_error,
    tc.cwd, tc.seq, tc.call_id, s.repository, s.checkout
FROM tool_call tc JOIN session s ON s.id = tc.session
WHERE tc.has_error = true AND tc.session IN (${placeholders}) ${sinceFilter}
ORDER BY tc.ts DESC`;
        const rows = yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, turn: Schema.NullOr(Schema.String), name: Schema.String,
            ts: TimestampColumn, status: Schema.NullOr(Schema.String), command_norm: Schema.NullOr(Schema.String),
            output_excerpt: Schema.NullOr(Schema.String), error_text: Schema.NullOr(Schema.String),
            exit_code: Schema.NullOr(NumberFromBigIntColumn), duration_ms: Schema.NullOr(NumberFromBigIntColumn),
            has_error: Schema.Boolean, cwd: Schema.NullOr(Schema.String), seq: NumberFromBigIntColumn,
            call_id: Schema.NullOr(Schema.String), repository: Schema.NullOr(Schema.String), checkout: Schema.NullOr(Schema.String),
        }), sql, [...sessionIds]);
        return [...rows] as unknown as ToolCallLike[];
    });

export interface DeriveStats {
    sessions: number;
    turns: number;
    corrections: number;
    /**
     * `turn -> proposed -> skill` EDGES written - a skill the turn named but did
     * not invoke. NOT improve-loop proposals (#742): this counter reading 376
     * while `ax improve list` stayed at 0 looked like a broken write path and
     * cost a reporter a debugging session. Improve proposals come from the
     * `proposals` / `retro-proposals` stages, never from here.
     */
    proposedSkillEdges: number;
    skillPairs: number;
    recoveries: number;
    frictionEvents: number;
    diagnosticEvents: number;
}

export interface DeriveOpts {
    sinceDays: number | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
}

export const deriveSignals = Effect.fn("derive.signals")(
    function* (write: CacheWriteService, opts: Partial<DeriveOpts> = {}) {
        const skillNames = yield* fetchSkillNames(write).pipe(
            Effect.withSpan("signals.fetch-skills"),
        );
        // Two passes, so the whole turn corpus never sits in the heap at once
        // (#1021): the cheap id pass bounds what we then pull one chunk at a
        // time. `totalSessions` is known up front, so progress still reports a
        // real denominator.
        const sessionIds = yield* fetchSessionIds(write, opts.sinceDays).pipe(
            Effect.tap((ids) => Effect.annotateCurrentSpan("signals.sessions", ids.length)),
            Effect.withSpan("signals.fetch-session-ids"),
        );
        const totalSessions = sessionIds.length;
        if (opts.onProgress) yield* opts.onProgress({ sessions: totalSessions });

        let corrections = 0;
        let proposedSkillEdges = 0;
        let turnCount = 0;
        let recoveries = 0;
        let sessionsSeen = 0;

        const correctionBatch: CorrectionEdge[] = [];
        const proposedBatch: ProposedEdge[] = [];
        const recoveryBatch: RecoveryEdge[] = [];
        // Folded into the session-chunk loop below (#1043): each chunk's error
        // tool_calls are fetched and turned into events immediately, so the
        // full error corpus never sits in the heap at once the way a single
        // post-loop fetch did. Only these (much smaller) derived-event
        // batches accumulate across chunks.
        const toolFrictionBatch: DerivedFrictionEvent[] = [];
        const diagnosticBatch: DerivedDiagnosticEvent[] = [];
        const pairsAccum = new Map<string, SkillPairAccum>();
        // Skill pairs are all-time aggregates - a --since-scoped derive must
        // not clobber them. Hoisted above the loop so we neither accumulate
        // pairs we'd discard nor report a mid-loop count that resets to 0.
        // Mirrors the includeSkillPairs gate in core's deriveSignalsFromEvidence.
        const shouldWriteSkillPairs = shouldDeriveAllTimeSkillPairs(opts.sinceDays);

        for (const idChunk of chunk(sessionIds, SESSION_BATCH_SIZE)) {
            const bundles = yield* fetchSessionTurnsForIds(write, idChunk, opts.sinceDays).pipe(
                Effect.withSpan("signals.fetch-turns", {
                    attributes: { "signals.chunk_sessions": idChunk.length },
                }),
            );
            for (const bundle of bundles) {
                sessionsSeen += 1;
                turnCount += bundle.turns.length;
                const c = deriveCorrections(bundle);
                const p = deriveProposed(bundle, skillNames);
                const r = deriveRecovered(bundle);
                corrections += c.length;
                proposedSkillEdges += p.length;
                recoveries += r.length;
                correctionBatch.push(...c);
                proposedBatch.push(...p);
                recoveryBatch.push(...r);
                if (shouldWriteSkillPairs) deriveSkillPairs(bundle, pairsAccum);
                if (opts.onProgress && (sessionsSeen <= 5 || sessionsSeen % 50 === 0)) {
                    yield* opts.onProgress({
                        currentFile: sessionsSeen,
                        totalFiles: totalSessions,
                        sessions: sessionsSeen,
                        turns: turnCount,
                        corrections,
                        proposedSkillEdges,
                        recoveries,
                        skillPairs: shouldWriteSkillPairs ? pairsAccum.size : 0,
                    });
                }
            }
            // Same chunk of session ids that bounded the turns fetch above also
            // bounds this fetch (#1043) - the failed-tool-calls read is a
            // SEPARATE materialisation from turns and was still unbounded, which
            // is what segfaulted a 90-day derive.
            const chunkFailedToolCalls = yield* fetchFailedToolCalls(write, idChunk, opts.sinceDays).pipe(
                Effect.tap((calls) => Effect.annotateCurrentSpan("signals.failed_tool_calls", calls.length)),
                Effect.withSpan("signals.fetch-failed-tools", {
                    attributes: { "signals.chunk_sessions": idChunk.length },
                }),
            );
            toolFrictionBatch.push(...deriveFrictionFromToolCalls(chunkFailedToolCalls));
            diagnosticBatch.push(...deriveDiagnosticsFromToolCalls(chunkFailedToolCalls));
        }

        const pairsList = shouldWriteSkillPairs
            ? [...pairsAccum.entries()].map(([edgeId, pair]) => ({ edgeId, pair }))
            : [];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: totalSessions,
                turns: turnCount,
                corrections,
                proposedSkillEdges,
                recoveries,
                skillPairs: pairsList.length,
            });
        }
        // `toolFrictionBatch` / `diagnosticBatch` were built chunk-by-chunk in
        // the loop above (#1043); `correctionBatch` still accumulates across
        // the whole run (it's small - one row per correction, not one per
        // error tool_call), so its friction derivation stays here, post-loop,
        // exactly as before.
        const correctionFrictionBatch = deriveFrictionFromCorrections(correctionBatch);
        const frictionBatch = [...toolFrictionBatch, ...correctionFrictionBatch];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: totalSessions,
                turns: turnCount,
                corrections,
                proposedSkillEdges,
                recoveries,
                skillPairs: pairsList.length,
                frictionEvents: frictionBatch.length,
                diagnosticEvents: diagnosticBatch.length,
            });
        }

        yield* write.putMany("corrected_by", correctionBatch.map((edge) => cacheRow({
            id: edgeRowId("corrected_by", edge.fromTurnKey, edge.toTurnKey), in_id: edge.fromTurnKey,
            out_id: edge.toTurnKey, pattern: edge.pattern, ts: tsParam(edge.ts) ?? new Date(),
        }))).pipe(
            Effect.withSpan("signals.write.corrections", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        // Denormalise was_corrected onto invoked edges so cmdTaste's
        // corrections subquery becomes a pure index/scan filter (issue #31).
        const wasCorrectedTurnKeys = correctedInvokedTurnKeys(correctionBatch);
        for (const key of wasCorrectedTurnKeys) yield* write.exec("UPDATE invoked SET was_corrected = true WHERE in_id = ?", [key]);
        yield* Effect.void.pipe(
            Effect.withSpan("signals.write.was-corrected", {
                attributes: { "signals.count": wasCorrectedTurnKeys.length },
            }),
        );
        yield* write.putMany("proposed", proposedBatch.map((edge) => cacheRow({
            id: edgeRowId("proposed", edge.fromTurnKey, edge.skillKey), in_id: edge.fromTurnKey,
            out_id: edge.skillKey, ts: tsParam(edge.ts) ?? new Date(), context_excerpt: edge.contextExcerpt,
        }))).pipe(
            Effect.withSpan("signals.write.proposed", {
                attributes: { "signals.count": proposedBatch.length },
            }),
        );
        if (shouldWriteSkillPairs) {
            yield* write.putMany("skill_paired", pairsList.map(({ edgeId, pair }) => cacheRow({
                id: edgeId, in_id: pair.fromKey, out_id: pair.toKey, count: pair.count,
                last_seen: tsParam(pair.lastSeen) ?? new Date(),
            }))).pipe(
                Effect.withSpan("signals.write.skill-pairs", {
                    attributes: { "signals.count": pairsList.length },
                }),
            );
        }
        yield* write.putMany("recovered_by", recoveryBatch.map((edge) => cacheRow({
            id: edgeRowId("recovered_by", edge.fromTurnKey, edge.skillKey), in_id: edge.fromTurnKey,
            out_id: edge.skillKey, ts: tsParam(edge.ts) ?? new Date(), error_excerpt: edge.errorExcerpt ?? null,
        }))).pipe(
            Effect.withSpan("signals.write.recovered", {
                attributes: { "signals.count": recoveryBatch.length },
            }),
        );
        // On a FULL re-derive, clear the standalone derived-event tables before
        // re-inserting so a row the current logic no longer emits cannot orphan
        // with a stale ts (#549). `shouldWriteSkillPairs` is exactly the
        // full-derive gate (sinceDays undefined / <=0); a --since run keeps the
        // UPSERT-only path so it never drops rows whose source is out of window.
        if (shouldWriteSkillPairs) {
            yield* write.exec("DELETE FROM friction_event");
            yield* write.exec("DELETE FROM diagnostic_event").pipe(Effect.withSpan("signals.clear.derived-events"));
        }
        yield* write.putMany("friction_event", frictionBatch.map((event) => cacheRow({
            id: event.key, session: event.sessionId, turn: event.turnKey, kind: event.kind,
            text: event.text, labels: jsonParam(event.labels), metrics: jsonParam(event.metrics),
            raw: jsonParam(event.raw), ts: tsParam(event.ts) ?? new Date(),
        }))).pipe(
            Effect.withSpan("signals.write.friction", {
                attributes: { "signals.count": frictionBatch.length },
            }),
        );
        yield* write.putMany("diagnostic_event", diagnosticBatch.map((event) => cacheRow({
            id: event.key, session: event.sessionId, turn: event.turnKey, kind: event.kind,
            status: event.status, text: event.text, labels: jsonParam(event.labels),
            metrics: jsonParam(event.metrics), raw: jsonParam(event.raw), ts: tsParam(event.ts) ?? new Date(),
        }))).pipe(
            Effect.withSpan("signals.write.diagnostics", {
                attributes: { "signals.count": diagnosticBatch.length },
            }),
        );

        yield* Effect.logDebug("signals derived", {
            sessions: totalSessions,
            turns: turnCount,
            corrections,
            proposedSkillEdges,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        });
        return {
            sessions: totalSessions,
            turns: turnCount,
            corrections,
            proposedSkillEdges,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        } satisfies DeriveStats;
    },
);

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const SignalsKey = Schema.Literal("signals");
export type SignalsKey = typeof SignalsKey.Type;

/**
 * Signals stage - derives Friction/Feedback/Diagnostic/Intent edges from
 * Tool Calls + Turns. Depends on {@link ClaudeKey}, {@link CodexKey},
 * {@link SubagentsKey}, {@link SpawnedKey}, {@link GitKey}.
 * Consumed by {@link OutcomesKey}, {@link SessionHealthKey}, {@link ClosureKey}.
 */
export class SignalsStats extends BaseStageStats.extend<SignalsStats>("SignalsStats")({
    frictionEvents: Schema.Number,
    diagnosticEvents: Schema.Number,
    corrections: Schema.Number,
    proposedSkillEdges: Schema.Number,
}) {}

export const signalsStage: StageDef<SignalsStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        key: "signals",
        deps: ["claude", "codex", "pi", "omp", "opencode", "cursor", "subagents", "spawned", "git"],
        tags: ["derive"],
        writes: [
            { table: "corrected_by", mode: "derive" },
            { table: "proposed", mode: "derive" },
            { table: "skill_paired", mode: "derive" },
            { table: "recovered_by", mode: "derive" },
            { table: "friction_event", mode: "derive" },
            { table: "diagnostic_event", mode: "derive" },
            { table: "invoked", mode: "enrich" }, // was_corrected stamping
        ],
    }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext, write: CacheWriteService) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        const result = yield* deriveSignals(write, { sinceDays });
        return SignalsStats.make({
            durationMs: Date.now() - t0,
            summary: `derived ${result.frictionEvents} friction, ${result.diagnosticEvents} diagnostic events`,
            frictionEvents: result.frictionEvents,
            diagnosticEvents: result.diagnosticEvents,
            corrections: result.corrections,
            proposedSkillEdges: result.proposedSkillEdges,
        });
    }),
};
