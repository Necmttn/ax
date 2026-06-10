import { Effect, Schema } from "effect";
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
    CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent,
    ProposedEdge, RecoveryEdge, SessionTurns, SkillPairAccum,
    ToolCallLike, TurnRow,
} from "./signals/types.ts";
// transitional re-export - deleted in Task 5 when consumers import signals/types directly
export type { DerivedDiagnosticEvent, DerivedFrictionEvent, SessionTurns, SkillPairAccum, ToolCallLike, TurnRow } from "./signals/types.ts";

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

const fetchSkillNames = (): Effect.Effect<string[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<{ name: string }>]>(
            `SELECT name FROM skill;`,
        );
        return (result?.[0] ?? []).map((r) => r.name).filter((n): n is string => Boolean(n));
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

// Statement templates live in ./signals/statements.ts (pure, golden-tested);
// the upsert* wrappers below only execute the built batches.
// `executeStatementsWith` no-ops on empty arrays, so no length guards needed.

const upsertCorrections = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildCorrectedByStatements(edges), { chunkSize: 500 });
    });

const markWasCorrected = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildWasCorrectedStatements(correctedInvokedTurnKeys(edges)), { chunkSize: 500 });
    });

const upsertProposed = (edges: ProposedEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildProposedStatements(edges), { chunkSize: 500 });
    });

const upsertSkillPairs = (
    pairs: ReadonlyArray<{ readonly edgeId: string; readonly pair: SkillPairAccum }>,
) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildSkillPairStatements(pairs), { chunkSize: 500 });
    });

const upsertRecovered = (edges: RecoveryEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildRecoveredStatements(edges), { chunkSize: 500 });
    });

const upsertFrictionEvents = (events: readonly DerivedFrictionEvent[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildFrictionEventStatements(events), { chunkSize: 500 });
    });

const upsertDiagnosticEvents = (events: readonly DerivedDiagnosticEvent[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildDiagnosticEventStatements(events), { chunkSize: 500 });
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

export const deriveSignals = (
    opts: Partial<DeriveOpts> = {},
): Effect.Effect<DeriveStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
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
            deriveSkillPairs(bundle, pairsAccum);
            if (opts.onProgress && (index < 5 || (index + 1) % 50 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: bundles.length,
                    sessions: index + 1,
                    turns: turnCount,
                    corrections,
                    proposed,
                    recoveries,
                    skillPairs: pairsAccum.size,
                });
            }
        }

        const shouldWriteSkillPairs = shouldDeriveAllTimeSkillPairs(opts.sinceDays);
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

        yield* upsertCorrections(correctionBatch).pipe(
            Effect.withSpan("signals.write.corrections", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        // Denormalise was_corrected onto invoked edges so cmdTaste's
        // corrections subquery becomes a pure index/scan filter (issue #31).
        yield* markWasCorrected(correctionBatch).pipe(
            Effect.withSpan("signals.write.was-corrected", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        yield* upsertProposed(proposedBatch).pipe(
            Effect.withSpan("signals.write.proposed", {
                attributes: { "signals.count": proposedBatch.length },
            }),
        );
        if (shouldWriteSkillPairs) {
            yield* upsertSkillPairs(pairsList).pipe(
                Effect.withSpan("signals.write.skill-pairs", {
                    attributes: { "signals.count": pairsList.length },
                }),
            );
        }
        yield* upsertRecovered(recoveryBatch).pipe(
            Effect.withSpan("signals.write.recovered", {
                attributes: { "signals.count": recoveryBatch.length },
            }),
        );
        yield* upsertFrictionEvents(frictionBatch).pipe(
            Effect.withSpan("signals.write.friction", {
                attributes: { "signals.count": frictionBatch.length },
            }),
        );
        yield* upsertDiagnosticEvents(diagnosticBatch).pipe(
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
        };
    });

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

import { BaseStageStats, IngestContext, sinceAndClause, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

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
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
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
