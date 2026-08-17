import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { isoMs, sessionIdsClause } from "./util.ts";

const ProducedRow = Schema.Struct({
    session: Schema.String,
    commit_ts: Schema.NullOr(TimestampColumn),
    sha: Schema.String,
});
const PullRequestRow = Schema.Struct({ merge_sha: Schema.String, merged_at: TimestampColumn });

/**
 * How long the session's work took to LAND: the minimum, across the session's
 * produced commits that match a merged PR's `merge_sha`, of
 * `pull_request.merged_at - commit.ts` (ms). null when nothing merged.
 *
 * Anchored on the COMMIT timestamp, not `session.ended_at`: long-running
 * sessions routinely merge PRs while still open, which made the ended_at
 * anchor negative in ~94% of real rows (blind-dogfood finding). commit→merge
 * is monotonic (a commit precedes its merge), so the metric is now a real
 * latency; residual negatives (clock skew across machines) are dropped.
 *
 * Two flat queries joined in JS rather than a single correlated subquery: the
 * merged-PR set is read once into a sha->merged_at map, then matched against
 * each produced commit in memory.
 */
export const computeTimeToLand = (
    read: CacheReadService,
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, CacheReadError> =>
    Effect.gen(function* () {
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const sessions = sessionIdsClause("p.in_id", sessionIds);
        // Produced commits: sha + the commit's own timestamp.
        const produced = yield* read.rows(
            ProducedRow,
            `SELECT p.in_id AS session, c.ts AS commit_ts, c.sha AS sha
             FROM produced p JOIN "commit" c ON c.id = p.out_id
             WHERE TRUE ${sessions.sql}`,
            sessions.params,
        );
        // Merged PRs → sha→merged_at lookup (one read over all merged PRs).
        const prs = yield* read.rows(
            PullRequestRow,
            `SELECT merge_sha, merged_at FROM pull_request WHERE merged_at IS NOT NULL AND merge_sha IS NOT NULL`,
        );
        const mergedAtBySha = new Map<string, Date>();
        for (const p of prs) {
            mergedAtBySha.set(p.merge_sha, p.merged_at);
        }

        const best = new Map<string, number>();
        for (const r of produced) {
            const session = String(r.session);
            const sha = typeof r.sha === "string" ? r.sha : null;
            const commitMs = isoMs(r.commit_ts);
            if (sha === null || commitMs === null) continue;
            const mergedAt = mergedAtBySha.get(sha);
            if (mergedAt === undefined) continue;
            const mergedMs = isoMs(mergedAt);
            if (mergedMs === null) continue;
            const ms = mergedMs - commitMs;
            if (ms < 0) continue; // clock skew guard - a commit precedes its merge
            const cur = best.get(session);
            if (cur === undefined || ms < cur) best.set(session, ms);
        }
        for (const [s, ms] of best) map.set(s, ms);
        return map;
    });
