import { Effect, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import {
    buildCorrectedByStatements, buildDiagnosticEventStatements,
    buildFrictionEventStatements, buildProposedStatements,
    buildRecoveredStatements, buildSkillPairStatements,
    buildWasCorrectedStatements, correctedInvokedTurnKeys,
} from "./signals/statements.ts";
import {
    deriveCorrections, deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections, deriveFrictionFromToolCalls,
    deriveProposed, deriveRecovered, deriveSkillPairs,
    groupTurnsBySession, shouldDeriveAllTimeSkillPairs,
} from "./signals/core.ts";
import type {
    CorrectionEdge, ProposedEdge, RecoveryEdge,
    SessionTurns, SkillPairAccum, ToolCallLike, TurnRow,
} from "./signals/types.ts";
import { BaseStageStats, IngestContext, sinceAndClause, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./stage/types.ts";
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
    sinceDays: number | undefined,
): Effect.Effect<SessionTurns[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sinceFilter = sinceWhereClause(sinceDays);
        const sql = `
SELECT
    id,
    session,
    seq,
    role,
    text_excerpt,
    ts,
    has_error,
    session.repository AS repository,
    session.checkout AS checkout,
    session.cwd AS cwd,
    ->invoked->skill.name AS invoked_skills
FROM turn
${sinceFilter}
ORDER BY session ASC, seq ASC;`;
        const result = yield* db.query<[TurnRow[] & { session: unknown }[]]>(sql);
        const rows = (result?.[0] ?? []) as Array<TurnRow & { session: unknown }>;
        return groupTurnsBySession(rows);
    });

const fetchSkillNames = (): Effect.Effect<SkillName[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<{ name: string }>]>(
            `SELECT name FROM skill;`,
        );
        // The skill table is the persisted catalog, i.e. a true producer of
        // canonical skill names - brand at this read boundary.
        return (result?.[0] ?? [])
            .map((r) => r.name)
            .filter((n): n is string => Boolean(n))
            .map((n) => SkillName.make(n));
    });

const fetchFailedToolCalls = (
    sinceDays: number | undefined,
): Effect.Effect<ToolCallLike[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sinceFilter = sinceAndClause(sinceDays);
        const sql = `
SELECT
    id,
    session,
    turn,
    tool,
    tool.name AS tool_name,
    name,
    ts,
    status,
    command_norm,
    output_excerpt,
    error_text,
    exit_code,
    duration_ms,
    has_error,
    cwd,
    seq,
    call_id,
    session.repository AS repository,
    session.checkout AS checkout
FROM tool_call
WHERE has_error = true ${sinceFilter}
ORDER BY ts DESC;`;
        const result = yield* db.query<[ToolCallLike[]]>(sql);
        return result?.[0] ?? [];
    });

export interface DeriveStats {
    sessions: number;
    turns: number;
    corrections: number;
    proposed: number;
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
    function* (opts: Partial<DeriveOpts> = {}) {
        const skillNames = yield* fetchSkillNames().pipe(
            Effect.withSpan("signals.fetch-skills"),
        );
        const bundles = yield* fetchSessionTurns(opts.sinceDays).pipe(
            Effect.tap((b) => Effect.annotateCurrentSpan("signals.sessions", b.length)),
            Effect.withSpan("signals.fetch-turns"),
        );
        if (opts.onProgress) yield* opts.onProgress({ sessions: bundles.length });

        let corrections = 0;
        let proposed = 0;
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
            proposed += p.length;
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
                    proposed,
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
                proposed,
                recoveries,
                skillPairs: pairsList.length,
            });
        }
        const failedToolCalls = yield* fetchFailedToolCalls(opts.sinceDays).pipe(
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
                proposed,
                recoveries,
                skillPairs: pairsList.length,
                frictionEvents: frictionBatch.length,
                diagnosticEvents: diagnosticBatch.length,
            });
        }

        // Write order mirrors the pre-split monolith. The batches are
        // independent (was_corrected keys come from the in-memory corrections
        // batch, not from previously written rows), so the ordering is for
        // diff-ability, not correctness. chunkSize 500 matches the pre-split
        // executor calls; executeStatementsWith no-ops on empty arrays, so no
        // length guards needed.
        const db = yield* SurrealClient;
        const exec = (stmts: readonly string[]) =>
            executeStatementsWith(db, stmts, { chunkSize: 500 });
        yield* exec(buildCorrectedByStatements(correctionBatch)).pipe(
            Effect.withSpan("signals.write.corrections", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        // Denormalise was_corrected onto invoked edges so cmdTaste's
        // corrections subquery becomes a pure index/scan filter (issue #31).
        const wasCorrectedTurnKeys = correctedInvokedTurnKeys(correctionBatch);
        yield* exec(buildWasCorrectedStatements(wasCorrectedTurnKeys)).pipe(
            Effect.withSpan("signals.write.was-corrected", {
                attributes: { "signals.count": wasCorrectedTurnKeys.length },
            }),
        );
        yield* exec(buildProposedStatements(proposedBatch)).pipe(
            Effect.withSpan("signals.write.proposed", {
                attributes: { "signals.count": proposedBatch.length },
            }),
        );
        if (shouldWriteSkillPairs) {
            yield* exec(buildSkillPairStatements(pairsList)).pipe(
                Effect.withSpan("signals.write.skill-pairs", {
                    attributes: { "signals.count": pairsList.length },
                }),
            );
        }
        yield* exec(buildRecoveredStatements(recoveryBatch)).pipe(
            Effect.withSpan("signals.write.recovered", {
                attributes: { "signals.count": recoveryBatch.length },
            }),
        );
        yield* exec(buildFrictionEventStatements(frictionBatch)).pipe(
            Effect.withSpan("signals.write.friction", {
                attributes: { "signals.count": frictionBatch.length },
            }),
        );
        yield* exec(buildDiagnosticEventStatements(diagnosticBatch)).pipe(
            Effect.withSpan("signals.write.diagnostics", {
                attributes: { "signals.count": diagnosticBatch.length },
            }),
        );

        yield* Effect.logDebug("signals derived", {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        });
        return {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        } satisfies DeriveStats;
    },
);

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveSignals({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveStats>,
    );
}

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
    proposed: Schema.Number,
}) {}

export const signalsStage: StageDef<SignalsStats, SurrealClient> = {
    meta: StageMeta.make({ key: "signals", deps: ["claude", "codex", "pi", "opencode", "cursor", "subagents", "spawned", "git"], tags: ["derive"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const sinceDays = sinceDaysFromCtx(ctx);
        const result = yield* deriveSignals({ sinceDays });
        return SignalsStats.make({
            durationMs: Date.now() - t0,
            summary: `derived ${result.frictionEvents} friction, ${result.diagnosticEvents} diagnostic events`,
            frictionEvents: result.frictionEvents,
            diagnosticEvents: result.diagnosticEvents,
            corrections: result.corrections,
            proposed: result.proposed,
        });
    }),
};
