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
    CorrectionEdge, ProposedEdge, RecoveryEdge,
    SessionTurns, SkillPairAccum, ToolCallLike,
} from "./signals/types.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

// Derivation rules live in ./signals/core.ts (pure, fixture-tested by
// signals/core.test.ts); this file is stage wiring only: three SELECTs, the
// per-bundle progress loop, statement building + chunked execution.

/**
 * Fetch every (session → turns) bundle in one round-trip. Each turn carries
 * its outgoing `->invoked->skill.name` array so we can detect "proposed but
 * not invoked" without a second query.
 */
const fetchSessionTurns = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<SessionTurns[], CacheWriteError> =>
    Effect.gen(function* () {
        const sinceFilter = sinceDays && sinceDays > 0 ? `WHERE t.ts > CURRENT_TIMESTAMP - INTERVAL '${Math.trunc(sinceDays)} days'` : "";
        const sql = `
SELECT
    t.id, t.session, t.seq, t.role, t.text_excerpt, t.ts, t.has_error,
    s.repository, s.checkout, s.cwd,
    COALESCE(to_json(list(DISTINCT sk.name) FILTER (WHERE sk.name IS NOT NULL))::VARCHAR, '[]') AS invoked_skills
FROM turn t JOIN session s ON s.id = t.session
LEFT JOIN invoked i ON i.in_id = t.id LEFT JOIN skill sk ON sk.id = i.out_id
${sinceFilter}
GROUP BY t.id, t.session, t.seq, t.role, t.text_excerpt, t.ts, t.has_error, s.repository, s.checkout, s.cwd
ORDER BY t.session ASC, t.seq ASC`;
        const rows = yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: NumberFromBigIntColumn, role: Schema.String,
            text_excerpt: Schema.NullOr(Schema.String), ts: TimestampColumn, has_error: Schema.Boolean,
            repository: Schema.NullOr(Schema.String), checkout: Schema.NullOr(Schema.String),
            cwd: Schema.NullOr(Schema.String), invoked_skills: Schema.String,
        }), sql);
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

const fetchFailedToolCalls = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<ToolCallLike[], CacheWriteError> =>
    Effect.gen(function* () {
        const sinceFilter = sinceDays && sinceDays > 0 ? `AND tc.ts > CURRENT_TIMESTAMP - INTERVAL '${Math.trunc(sinceDays)} days'` : "";
        const sql = `
SELECT
    tc.id, tc.session, tc.turn, tc.name, tc.ts, tc.status, tc.command_norm,
    tc.output_excerpt, tc.error_text, tc.exit_code, tc.duration_ms, tc.has_error,
    tc.cwd, tc.seq, tc.call_id, s.repository, s.checkout
FROM tool_call tc JOIN session s ON s.id = tc.session
WHERE tc.has_error = true ${sinceFilter}
ORDER BY tc.ts DESC`;
        const rows = yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, turn: Schema.NullOr(Schema.String), name: Schema.String,
            ts: TimestampColumn, status: Schema.NullOr(Schema.String), command_norm: Schema.NullOr(Schema.String),
            output_excerpt: Schema.NullOr(Schema.String), error_text: Schema.NullOr(Schema.String),
            exit_code: Schema.NullOr(NumberFromBigIntColumn), duration_ms: Schema.NullOr(NumberFromBigIntColumn),
            has_error: Schema.Boolean, cwd: Schema.NullOr(Schema.String), seq: NumberFromBigIntColumn,
            call_id: Schema.NullOr(Schema.String), repository: Schema.NullOr(Schema.String), checkout: Schema.NullOr(Schema.String),
        }), sql);
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
        const bundles = yield* fetchSessionTurns(write, opts.sinceDays).pipe(
            Effect.tap((b) => Effect.annotateCurrentSpan("signals.sessions", b.length)),
            Effect.withSpan("signals.fetch-turns"),
        );
        if (opts.onProgress) yield* opts.onProgress({ sessions: bundles.length });

        let corrections = 0;
        let proposedSkillEdges = 0;
        let turnCount = 0;
        let recoveries = 0;

        const correctionBatch: CorrectionEdge[] = [];
        const proposedBatch: ProposedEdge[] = [];
        const recoveryBatch: RecoveryEdge[] = [];
        const pairsAccum = new Map<string, SkillPairAccum>();
        // Skill pairs are all-time aggregates - a --since-scoped derive must
        // not clobber them. Hoisted above the loop so we neither accumulate
        // pairs we'd discard nor report a mid-loop count that resets to 0.
        // Mirrors the includeSkillPairs gate in core's deriveSignalsFromEvidence.
        const shouldWriteSkillPairs = shouldDeriveAllTimeSkillPairs(opts.sinceDays);

        for (const [index, bundle] of bundles.entries()) {
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
            if (opts.onProgress && (index < 5 || (index + 1) % 50 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: bundles.length,
                    sessions: index + 1,
                    turns: turnCount,
                    corrections,
                    proposedSkillEdges,
                    recoveries,
                    skillPairs: shouldWriteSkillPairs ? pairsAccum.size : 0,
                });
            }
        }

        const pairsList = shouldWriteSkillPairs
            ? [...pairsAccum.entries()].map(([edgeId, pair]) => ({ edgeId, pair }))
            : [];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
                turns: turnCount,
                corrections,
                proposedSkillEdges,
                recoveries,
                skillPairs: pairsList.length,
            });
        }
        const failedToolCalls = yield* fetchFailedToolCalls(write, opts.sinceDays).pipe(
            Effect.tap((calls) => Effect.annotateCurrentSpan("signals.failed_tool_calls", calls.length)),
            Effect.withSpan("signals.fetch-failed-tools"),
        );
        const toolFrictionBatch = deriveFrictionFromToolCalls(failedToolCalls);
        const correctionFrictionBatch = deriveFrictionFromCorrections(correctionBatch);
        const frictionBatch = [...toolFrictionBatch, ...correctionFrictionBatch];
        const diagnosticBatch = deriveDiagnosticsFromToolCalls(failedToolCalls);
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
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
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposedSkillEdges,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        });
        return {
            sessions: bundles.length,
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
    meta: StageMeta.make({ key: "signals", deps: ["claude", "codex", "pi", "omp", "opencode", "cursor", "subagents", "spawned", "git"], tags: ["derive"] }),
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
