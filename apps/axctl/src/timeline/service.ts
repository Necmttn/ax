/**
 * SessionTimelineService - feed a session id, get the highlight/event timeline.
 * Thin Effect wrapper: runs the session-scoped queries in parallel, maps rows
 * to clean shapes, and hands them to the pure `buildTimeline` derivation. All
 * the logic lives in `derive.ts` (testable without a DB); this layer is just
 * I/O + composition.
 */
import { Context, Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { buildTimeline } from "./derive.ts";
import type { SessionTimeline } from "./types.ts";
import {
    asksSql,
    commitsSql,
    compactionsSql,
    correctionsSql,
    costSql,
    editsSql,
    editStatsSql,
    healthSql,
    lastAssistantSql,
    mapAsk,
    mapCommit,
    mapCompaction,
    intentCorrectionsSql,
    mapCorrection,
    mapIntentCorrection,
    mapCost,
    mapEdit,
    mapEditStat,
    mapHealth,
    mapLastTurn,
    mapOverview,
    mapPlan,
    mapSkill,
    mapToolCall,
    overviewSql,
    plansSql,
    sessionRef,
    skillsSql,
    toolCallsSql,
} from "./queries.ts";

const present = <T>(x: T | null): x is T => x !== null;

export interface SessionTimelineShape {
    readonly extract: (sessionId: string) => Effect.Effect<SessionTimeline>;
}

export class SessionTimelineService extends Context.Service<
    SessionTimelineService,
    SessionTimelineShape
>()("ax/SessionTimelineService") {}

export const SessionTimelineServiceLayer = Layer.effect(SessionTimelineService)(
    Effect.gen(function* () {
            const db = yield* SurrealClient;

            const rows = (sql: string) =>
                db.query<[Array<Record<string, unknown>>]>(sql).pipe(
                    Effect.map((r) => r?.[0] ?? []),
                    Effect.orDie, // a read-only timeline query failing is a defect, not a domain error
                );
            const oneRow = (sql: string) =>
                rows(sql).pipe(Effect.map((rs) => rs[0] ?? null));

            const extract = Effect.fn("SessionTimelineService.extract")(function* (sessionId: string) {
                const ref = sessionRef(sessionId);
                const [
                    healthRaw, overviewRaw, costRaw, toolRaw, editRaw, editStatRaw,
                    skillRaw, correctionRaw, intentCorrectionRaw, planRaw, commitRaw, askRaw, compactionRaw, lastRaw,
                ] = yield* Effect.all([
                    oneRow(healthSql(ref)),
                    oneRow(overviewSql(ref)),
                    oneRow(costSql(ref)),
                    rows(toolCallsSql(ref)),
                    rows(editsSql(ref)),
                    rows(editStatsSql(ref)),
                    rows(skillsSql(ref)),
                    rows(correctionsSql(ref)),
                    rows(intentCorrectionsSql(ref)),
                    rows(plansSql(ref)),
                    rows(commitsSql(ref)),
                    rows(asksSql(ref)),
                    rows(compactionsSql(ref)),
                    oneRow(lastAssistantSql(ref)),
                ], { concurrency: "unbounded" });

                const overview = mapOverview(overviewRaw);
                // Merge both correction sources, dedupe by seq (reaction_event wins - it has a target).
                const correctionBySeq = new Map<number, ReturnType<typeof mapCorrection>>();
                for (const c of intentCorrectionRaw.map(mapIntentCorrection).filter(present)) {
                    if (c.seq != null) correctionBySeq.set(c.seq, c);
                }
                for (const c of correctionRaw.map(mapCorrection).filter(present)) {
                    if (c.seq != null) correctionBySeq.set(c.seq, c);
                }
                const corrections = [...correctionBySeq.values()].filter(present).sort((a, b) => (a!.seq ?? 0) - (b!.seq ?? 0));

                return buildTimeline({
                    sessionId,
                    source: overview?.source ?? "claude",
                    health: mapHealth(healthRaw),
                    overview,
                    cost: mapCost(costRaw),
                    toolCalls: toolRaw.map(mapToolCall).filter(present),
                    edits: editRaw.map(mapEdit).filter(present),
                    editStats: editStatRaw.map(mapEditStat).filter(present),
                    skills: skillRaw.map(mapSkill).filter(present),
                    corrections,
                    plans: planRaw.map(mapPlan).filter(present),
                    commits: commitRaw.map(mapCommit).filter(present),
                    asks: askRaw.map(mapAsk).filter(present),
                    compactions: compactionRaw.map(mapCompaction).filter(present),
                    lastAssistant: mapLastTurn(lastRaw),
                });
            });

            return { extract } satisfies SessionTimelineShape;
        }),
);

/** Convenience: extract a timeline using the ambient SessionTimelineService. */
export const extractSessionTimeline = (
    sessionId: string,
): Effect.Effect<SessionTimeline, never, SessionTimelineService> =>
    Effect.flatMap(SessionTimelineService, (svc) => svc.extract(sessionId));
