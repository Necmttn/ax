import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, type IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { advanceRevertedWatermark, computeRevertedCommits } from "../metrics/commit-reverted.ts";
import { advancePrMergeWatermark, computePrMergeDirtySessions } from "../metrics/pr-merge-dirty.ts";
import { computeDurability } from "../metrics/durability.ts";
import { computeTimeToLand } from "../metrics/time-to-land.ts";
import { computeSessionLoc } from "../metrics/session-loc.ts";
import { computeTimeToFirstEdit } from "../metrics/time-to-first-edit.ts";
import { computeColdStartReads } from "../metrics/cold-start-reads.ts";
import { computeDelegationRatio } from "../metrics/delegation-ratio.ts";
import { deriveFragilityCascade } from "../metrics/fragility-cascade.ts";

export interface DeriveMetricsStats {
    readonly sessionsWritten: number;
    readonly revertedCommits: number;
    readonly cascadeEdges: number;
}

const num = (n: number | null): string => (n === null ? "NONE" : String(n));

/**
 * Recompute the per-session metrics rollup.
 *
 * Order matters: (1) refresh the full-history `commit.reverted` primitive
 * (ADR-0011 freshness backbone); (2) compute the *dirty set* - sessions started
 * within the ingest window, OR that produced a now-reverted commit, OR that
 * produced a commit whose PR merge state changed since the last run (issue
 * #172) - so an old session's durability recomputes when a NEW fix lands for
 * its OLD commit, and its time_to_land recomputes when its PR merges LATER,
 * not just when the session itself is re-ingested; (3) derive the wave-1
 * scalars for the dirty set; (4) UPSERT one `session_metrics` row per dirty
 * session.
 */
export const deriveMetrics = (
    opts: { sinceDays: number | undefined },
): Effect.Effect<DeriveMetricsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Freshness backbone - full-history commit.reverted (diff-only writes).
        const reverted = yield* computeRevertedCommits();

        // 1b. PR-driven dirty source (issue #172): sessions producing commits
        //     whose pull_request merge_sha/merged_at changed since the last
        //     github-pr ingest. Without this, an OLD session whose PR merges
        //     LATER keeps a stale/NULL time_to_land_ms on the daemon's
        //     `--since=1` path until a full re-derive.
        const prDirty = yield* computePrMergeDirtySessions();

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
        const dirtySet = new Set(
            (dirty as unknown as unknown[]).filter(
                (s): s is string => typeof s === "string" && s.length > 0,
            ),
        );
        // Merge the PR-driven dirty sessions (already `type::string(id)` strings).
        for (const id of prDirty.dirtySessionIds) dirtySet.add(id);
        const sessionIds = [...dirtySet];
        if (sessionIds.length === 0) {
            // No dirty sessions. New cascade edges are only possible when the
            // reverted set itself changed (no new sessions ⇒ no new `edited`
            // edges), so the bounded cascade re-derive runs only on that path -
            // BEFORE the watermarks advance, so a crash re-runs it next time.
            const cascadeEdges = reverted.skipped ? 0 : yield* deriveFragilityCascade();
            if (!reverted.skipped) yield* advanceRevertedWatermark(reverted.fingerprint);
            // Safe here: prDirty.diff only carries PRs whose merge sha RESOLVED
            // locally (unresolved ones are held back to re-diff next run), so
            // "no dirty sessions" means the resolved PRs mapped to no producing
            // sessions - there are no dependent rows to write first.
            if (!prDirty.skipped) yield* advancePrMergeWatermark(prDirty.diff);
            return { sessionsWritten: 0, revertedCommits: reverted.revertedCount, cascadeEdges };
        }

        // 2b. Spawn-parent expansion: a dirty CHILD means its parent's
        //     delegation_ratio may have changed, but a parent outside the ingest
        //     window is not in the base dirty set. Walk the transitive
        //     spawn-PARENT closure of the dirty set so those parents recompute
        //     too. Bounded (depth cap 8) + cycle-guarded (`!all.has`) against
        //     cyclic/self spawn edges.
        let frontier = new Set(sessionIds);
        const all = new Set(sessionIds);
        for (let depth = 0; depth < 8 && frontier.size > 0; depth++) {
            const refs = [...frontier].map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? "")).join(", ");
            const parents = (yield* db.query<[string[]]>(
                `SELECT VALUE type::string(in) FROM spawned WHERE out IN [${refs}];`,
            ))?.[0] ?? [];
            frontier = new Set();
            for (const p of parents) if (typeof p === "string" && !all.has(p)) { all.add(p); frontier.add(p); }
        }
        const expandedIds = [...all];

        // 3. Wave-1 + wave-2 scalars for the dirty set (+ spawn parents).
        const [dur, ttl, loc, tfe, csr, del] = yield* Effect.all(
            [
                computeDurability(expandedIds),
                computeTimeToLand(expandedIds),
                computeSessionLoc(expandedIds),
                computeTimeToFirstEdit(expandedIds),
                computeColdStartReads(expandedIds),
                computeDelegationRatio(expandedIds),
            ],
            { concurrency: 6 },
        );

        // 4. One session_metrics row per dirty session (+ spawn parents).
        const stmts = expandedIds.map((id) => {
            const key = recordKeyPart(id, "session") ?? "";
            const sessionRef = recordLiteral("session", key);
            const d = dur.get(id) ?? { produced: 0, reverted: 0, ratio: null };
            const t = ttl.get(id) ?? null;
            const l = loc.get(id) ?? { added: 0, removed: 0 };
            return `UPSERT ${recordLiteral("session_metrics", key)} CONTENT { `
                + `session: ${sessionRef}, `
                + `durability_ratio: ${num(d.ratio)}, produced_commits: ${d.produced}, reverted_commits: ${d.reverted}, `
                + `time_to_land_ms: ${num(t)}, lines_added: ${l.added}, lines_removed: ${l.removed}, `
                + `time_to_first_edit_ms: ${num(tfe.get(id) ?? null)}, cold_start_reads: ${csr.get(id) ?? 0}, `
                + `delegation_ratio: ${num(del.get(id) ?? null)}, `
                + `ts: time::now() };`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });

        // 5. Fragility-cascade precompute (issue #171): bounded full rewrite of
        //    the `fragility_cascade` table so `ax signals show fragility_cascade`
        //    reads stored rows instead of doing live edge derefs. Runs whenever
        //    sessions were dirty (new `edited` edges can add downstream fixers)
        //    and on reverted-set changes (handled above for the empty dirty set).
        const cascadeEdges = yield* deriveFragilityCascade();

        // Advance the commit-reverted + PR-merge watermarks ONLY now that the
        // dependent session_metrics rows are persisted - a crash before this
        // point re-scans next run instead of silently skipping the affected
        // sessions (codex #2).
        if (!reverted.skipped) yield* advanceRevertedWatermark(reverted.fingerprint);
        if (!prDirty.skipped) yield* advancePrMergeWatermark(prDirty.diff);
        return { sessionsWritten: expandedIds.length, revertedCommits: reverted.revertedCount, cascadeEdges };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const DeriveMetricsKey = Schema.Literal("derive-metrics");
export type DeriveMetricsKey = typeof DeriveMetricsKey.Type;

export class DeriveMetricsStageStats extends BaseStageStats.extend<DeriveMetricsStageStats>("DeriveMetricsStageStats")({
    sessionsWritten: Schema.Number,
    revertedCommits: Schema.Number,
    cascadeEdges: Schema.Number,
}) {}

export const deriveMetricsStage: StageDef<DeriveMetricsStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "derive-metrics", deps: ["git", "session-health", "spawned"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const r = yield* deriveMetrics({ sinceDays: sinceDaysFromCtx(ctx) });
            return DeriveMetricsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${r.sessionsWritten} session_metrics rows; ${r.revertedCommits} reverted commits; ${r.cascadeEdges} cascade edges`,
                sessionsWritten: r.sessionsWritten,
                revertedCommits: r.revertedCommits,
                cascadeEdges: r.cascadeEdges,
            });
        }),
};
