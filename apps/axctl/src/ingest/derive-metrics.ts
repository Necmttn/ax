import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, type IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { computeRevertedCommits } from "../metrics/commit-reverted.ts";
import { computeDurability } from "../metrics/durability.ts";
import { computeTimeToLand } from "../metrics/time-to-land.ts";
import { computeSessionLoc } from "../metrics/session-loc.ts";

export interface DeriveMetricsStats {
    readonly sessionsWritten: number;
    readonly revertedCommits: number;
}

const num = (n: number | null): string => (n === null ? "NONE" : String(n));

/**
 * Recompute the per-session metrics rollup.
 *
 * Order matters: (1) refresh the full-history `commit.reverted` primitive
 * (ADR-0011 freshness backbone); (2) compute the *dirty set* - sessions started
 * within the ingest window OR that produced a now-reverted commit - so an old
 * session's durability recomputes when a NEW fix lands for its OLD commit, not
 * just when the session itself is re-ingested; (3) derive the wave-1 scalars for
 * the dirty set; (4) UPSERT one `session_metrics` row per dirty session.
 */
export const deriveMetrics = (
    opts: { sinceDays: number | undefined },
): Effect.Effect<DeriveMetricsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Freshness backbone - full-history commit.reverted (diff-only writes).
        const reverted = yield* computeRevertedCommits();

        // 2. Dirty set: sessions in the window, PLUS any session that produced a
        //    commit whose `reverted` flag *changed* this run (either direction).
        //    Keying on the changed set - not "currently reverted" - is what makes
        //    a true→false flip recompute the old session's durability instead of
        //    leaving it stale-low (codex adversarial #1 / ADR-0011 dirty-set).
        const sinceClause = opts.sinceDays
            ? `started_at >= time::now() - ${Math.max(1, Math.trunc(opts.sinceDays))}d`
            : "true";
        const changedRefs = reverted.changedKeys.map((k) => recordLiteral("commit", k));
        const changedClause = changedRefs.length > 0
            ? ` OR id IN (SELECT VALUE in FROM produced WHERE out IN [${changedRefs.join(", ")}])`
            : "";
        const dirty = (yield* db.query<[string[]]>(
            `SELECT VALUE type::string(id) FROM session WHERE ${sinceClause}${changedClause};`,
        ))?.[0] ?? [];
        const sessionIds = (dirty as unknown as unknown[]).filter(
            (s): s is string => typeof s === "string" && s.length > 0,
        );
        if (sessionIds.length === 0) {
            return { sessionsWritten: 0, revertedCommits: reverted.revertedCount };
        }

        // 3. Wave-1 scalars for the dirty set.
        const [dur, ttl, loc] = yield* Effect.all(
            [computeDurability(sessionIds), computeTimeToLand(sessionIds), computeSessionLoc(sessionIds)],
            { concurrency: 3 },
        );

        // 4. One session_metrics row per dirty session.
        const stmts = sessionIds.map((id) => {
            const key = recordKeyPart(id, "session") ?? "";
            const sessionRef = recordLiteral("session", key);
            const d = dur.get(id) ?? { produced: 0, reverted: 0, ratio: null };
            const t = ttl.get(id) ?? null;
            const l = loc.get(id) ?? { added: 0, removed: 0 };
            return `UPSERT ${recordLiteral("session_metrics", key)} CONTENT { `
                + `session: ${sessionRef}, `
                + `durability_ratio: ${num(d.ratio)}, produced_commits: ${d.produced}, reverted_commits: ${d.reverted}, `
                + `time_to_land_ms: ${num(t)}, lines_added: ${l.added}, lines_removed: ${l.removed}, `
                + `ts: time::now() };`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return { sessionsWritten: sessionIds.length, revertedCommits: reverted.revertedCount };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const DeriveMetricsKey = Schema.Literal("derive-metrics");
export type DeriveMetricsKey = typeof DeriveMetricsKey.Type;

export class DeriveMetricsStageStats extends BaseStageStats.extend<DeriveMetricsStageStats>("DeriveMetricsStageStats")({
    sessionsWritten: Schema.Number,
    revertedCommits: Schema.Number,
}) {}

export const deriveMetricsStage: StageDef<DeriveMetricsStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "derive-metrics", deps: ["git", "github-pr", "session-health"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const r = yield* deriveMetrics({ sinceDays: sinceDaysFromCtx(ctx) });
            return DeriveMetricsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${r.sessionsWritten} session_metrics rows; ${r.revertedCommits} reverted commits`,
                sessionsWritten: r.sessionsWritten,
                revertedCommits: r.revertedCommits,
            });
        }),
};
