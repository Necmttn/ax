import { Effect, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { inClause } from "@ax/lib/duckdb/clause";
import { BaseStageStats, type IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { IngestStageError, StageDef } from "./stage/registry.ts";
import { advanceRevertedWatermark, computeRevertedCommits } from "../metrics/commit-reverted.ts";
import { advancePrMergeWatermark, computePrMergeDirtySessions } from "../metrics/pr-merge-dirty.ts";
import { computeDurability } from "../metrics/durability.ts";
import { computeTimeToLand } from "../metrics/time-to-land.ts";
import { computeSessionLoc } from "../metrics/session-loc.ts";
import { computeTimeToFirstEdit } from "../metrics/time-to-first-edit.ts";
import { computeColdStartReads } from "../metrics/cold-start-reads.ts";
import { computeDelegationRatio } from "../metrics/delegation-ratio.ts";
import { deriveFragilityCascade } from "../metrics/fragility-cascade.ts";
import { deriveCostBackfill } from "./derive-cost-backfill.ts";

export interface DeriveMetricsStats {
    readonly sessionsWritten: number;
    readonly revertedCommits: number;
    readonly cascadeEdges: number;
    /** session_token_usage rows whose estimated cost was persisted this run. */
    readonly costBackfilled: number;
}

const SessionIdRow = Schema.Struct({ id: Schema.String });
const ParentRow = Schema.Struct({ parent: Schema.String });

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
export const deriveMetrics = Effect.fn("derive.metrics")(
    function* (write: CacheWriteService, opts: { sinceDays: number | undefined }) {

        // 0. Stored cost backfill: price `session_token_usage` rows that were
        //    never priced at ingest and persist `estimated_cost_usd` +
        //    `pricing_source: "estimated:<catalog>"`, so EVERY reader (dashboard
        //    cost view, summaries, share manifests) sees the cost without
        //    needing the read-time `fillEstimatedCost` helper. Independent of
        //    the dirty set - runs before the empty-dirty early return so daemon
        //    `--since=1` ingests heal history incrementally.
        const costs = yield* deriveCostBackfill(write).pipe(
            Effect.tap((c) => Effect.annotateCurrentSpan("derive.cost.backfilled", c.backfilled)),
            Effect.withSpan("derive.cost-backfill"),
        );

        // 1. Freshness backbone - full-history commit.reverted (diff-only writes).
        const reverted = yield* computeRevertedCommits(write).pipe(
            Effect.tap((r) =>
                Effect.all([
                    Effect.annotateCurrentSpan("derive.reverted.count", r.revertedCount),
                    Effect.annotateCurrentSpan("derive.reverted.skipped", r.skipped),
                ]),
            ),
            Effect.withSpan("derive.commit-reverted"),
        );

        // 1b. PR-driven dirty source (issue #172): sessions producing commits
        //     whose pull_request merge_sha/merged_at changed since the last
        //     github-pr ingest. Without this, an OLD session whose PR merges
        //     LATER keeps a stale/NULL time_to_land_ms on the daemon's
        //     `--since=1` path until a full re-derive.
        const prDirty = yield* computePrMergeDirtySessions(write).pipe(
            Effect.withSpan("derive.pr-merge-dirty"),
        );

        // 2. Dirty set: sessions in the window, PLUS any session that produced a
        //    commit whose `reverted` flag *changed* this run (either direction).
        //    Keying on the changed set - not "currently reverted" - is what makes
        //    a true→false flip recompute the old session's durability instead of
        //    leaving it stale-low (codex adversarial #1 / ADR-0011 dirty-set).
        const conditions: string[] = [];
        const params: Array<string | Date> = [];
        if (opts.sinceDays !== undefined) {
            conditions.push(`s.started_at >= ?`);
            params.push(new Date(Date.now() - Math.max(1, Math.trunc(opts.sinceDays)) * 86_400_000));
        }
        if (reverted.changedKeys.length > 0) {
            const changed = inClause("p.out_id", reverted.changedKeys);
            conditions.push(changed.sql.replace(/^AND /, ""));
            params.push(...changed.params as string[]);
        }
        const dirty = yield* write.rows(
            SessionIdRow,
            `SELECT DISTINCT s.id FROM session s LEFT JOIN produced p ON p.in_id = s.id`
                + (conditions.length === 0 ? "" : ` WHERE ${conditions.join(" OR ")}`),
            params,
        ).pipe(Effect.withSpan("derive.dirty-set"));
        const dirtySet = new Set(dirty.map((row) => row.id));
        // Merge the PR-driven dirty sessions (already `type::string(id)` strings).
        for (const id of prDirty.dirtySessionIds) dirtySet.add(id);
        const sessionIds = [...dirtySet];
        if (sessionIds.length === 0) {
            // No dirty sessions. New cascade edges are only possible when the
            // reverted set itself changed (no new sessions ⇒ no new `edited`
            // edges), so the bounded cascade re-derive runs only on that path -
            // BEFORE the watermarks advance, so a crash re-runs it next time.
            const cascadeEdges = reverted.skipped
                ? 0
                : yield* deriveFragilityCascade(write).pipe(
                    Effect.tap((edges) => Effect.annotateCurrentSpan("derive.cascade.edges", edges)),
                    Effect.withSpan("derive.fragility-cascade", {
                        attributes: { "derive.cascade.path": "empty-dirty" },
                    }),
                );
            if (!reverted.skipped) yield* advanceRevertedWatermark(write, reverted.fingerprint);
            // Safe here: prDirty.diff only carries PRs whose merge sha RESOLVED
            // locally (unresolved ones are held back to re-diff next run), so
            // "no dirty sessions" means the resolved PRs mapped to no producing
            // sessions - there are no dependent rows to write first.
            if (!prDirty.skipped) yield* advancePrMergeWatermark(write, prDirty.diff);
            return { sessionsWritten: 0, revertedCommits: reverted.revertedCount, cascadeEdges, costBackfilled: costs.backfilled };
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
            const clause = inClause("out_id", [...frontier]);
            const parents = yield* write.rows(
                ParentRow,
                `SELECT DISTINCT in_id AS parent FROM spawned WHERE true ${clause.sql}`,
                clause.params,
            ).pipe(Effect.withSpan("derive.spawn-parents", {
                attributes: { "derive.spawn.depth": depth, "derive.spawn.frontier": frontier.size },
            }));
            frontier = new Set();
            for (const row of parents) if (!all.has(row.parent)) { all.add(row.parent); frontier.add(row.parent); }
        }
        const expandedIds = [...all];

        // 3. Wave-1 + wave-2 scalars for the dirty set (+ spawn parents).
        const [dur, ttl, loc, tfe, csr, del] = yield* Effect.all(
            [
                computeDurability(write, expandedIds),
                computeTimeToLand(write, expandedIds),
                computeSessionLoc(write, expandedIds),
                computeTimeToFirstEdit(write, expandedIds),
                computeColdStartReads(write, expandedIds),
                computeDelegationRatio(write, expandedIds),
            ],
            { concurrency: 6 },
        ).pipe(
            // ONE span for the whole per-session metric computation (NOT per
            // session - bounded cardinality), carrying the dirty-set size.
            Effect.withSpan("derive.session-metrics", {
                attributes: { "derive.sessions": expandedIds.length },
            }),
        );

        // 4. One session_metrics row per dirty session (+ spawn parents).
        const rows = expandedIds.map((id) => {
            const d = dur.get(id) ?? { produced: 0, reverted: 0, ratio: null };
            const t = ttl.get(id) ?? null;
            const l = loc.get(id) ?? { added: 0, removed: 0 };
            return {
                id,
                session: id,
                durability_ratio: d.ratio,
                produced_commits: d.produced,
                reverted_commits: d.reverted,
                time_to_land_ms: t,
                lines_added: l.added,
                lines_removed: l.removed,
                time_to_first_edit_ms: tfe.get(id) ?? null,
                cold_start_reads: csr.get(id) ?? 0,
                delegation_ratio: del.get(id) ?? null,
            };
        });
        yield* write.putMany("session_metrics", rows);

        // 5. Fragility-cascade precompute (issue #171): bounded full rewrite of
        //    the `fragility_cascade` table so `ax signals show fragility_cascade`
        //    reads stored rows instead of doing live edge derefs. Runs whenever
        //    sessions were dirty (new `edited` edges can add downstream fixers)
        //    and on reverted-set changes (handled above for the empty dirty set).
        const cascadeEdges = yield* deriveFragilityCascade(write).pipe(
            Effect.tap((edges) => Effect.annotateCurrentSpan("derive.cascade.edges", edges)),
            Effect.withSpan("derive.fragility-cascade", {
                attributes: { "derive.cascade.path": "dirty" },
            }),
        );

        // Advance the commit-reverted + PR-merge watermarks ONLY now that the
        // dependent session_metrics rows are persisted - a crash before this
        // point re-scans next run instead of silently skipping the affected
        // sessions (codex #2).
        if (!reverted.skipped) yield* advanceRevertedWatermark(write, reverted.fingerprint);
        if (!prDirty.skipped) yield* advancePrMergeWatermark(write, prDirty.diff);
        return { sessionsWritten: expandedIds.length, revertedCommits: reverted.revertedCount, cascadeEdges, costBackfilled: costs.backfilled } satisfies DeriveMetricsStats;
    },
);

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const DeriveMetricsKey = Schema.Literal("derive-metrics");
export type DeriveMetricsKey = typeof DeriveMetricsKey.Type;

export class DeriveMetricsStageStats extends BaseStageStats.extend<DeriveMetricsStageStats>("DeriveMetricsStageStats")({
    sessionsWritten: Schema.Number,
    revertedCommits: Schema.Number,
    cascadeEdges: Schema.Number,
    costBackfilled: Schema.Number,
}) {}

export const deriveMetricsStage: StageDef<DeriveMetricsStageStats, never, IngestStageError> = {
    meta: StageMeta.make({ key: "derive-metrics", deps: ["git", "session-health", "spawned"], tags: ["derive"] }),
    // Unnamed Effect.fn: the stage runner's LiveTrace.step span already names
    // this boundary by the stage key, so a named span here would double-wrap.
    run: Effect.fn(function* (ctx: IngestContext, write: CacheWriteService) {
        const t0 = Date.now();
        const r = yield* deriveMetrics(write, { sinceDays: sinceDaysFromCtx(ctx) });
        return DeriveMetricsStageStats.make({
            durationMs: Date.now() - t0,
            summary: `wrote ${r.sessionsWritten} session_metrics rows; ${r.revertedCommits} reverted commits; ${r.cascadeEdges} cascade edges; ${r.costBackfilled} costs backfilled`,
            sessionsWritten: r.sessionsWritten,
            revertedCommits: r.revertedCommits,
            cascadeEdges: r.cascadeEdges,
            costBackfilled: r.costBackfilled,
        });
    }),
};
