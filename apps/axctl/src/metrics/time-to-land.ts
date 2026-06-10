import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { isoMs, sessionRefList } from "./util.ts";

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
 * Two flat queries joined in JS rather than a correlated subquery - SurrealDB
 * rejects the `FROM pull_request AS pr` table alias used by the inline form, and
 * two set-based reads keep us off the per-edge-deref hang path.
 */
export const computeTimeToLand = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const refs = sessionRefList(sessionIds);
        // Produced commits: sha + the commit's own timestamp.
        const produced = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(in) AS session, type::string(out.ts) AS commit_ts, out.sha AS sha`
            + ` FROM produced WHERE in IN [${refs}];`,
        ))?.[0] ?? [];
        // Merged PRs → sha→merged_at lookup (one read over all merged PRs).
        const prs = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT merge_sha, type::string(merged_at) AS merged_at`
            + ` FROM pull_request WHERE merged_at != NONE AND merge_sha != NONE;`,
        ))?.[0] ?? [];
        const mergedAtBySha = new Map<string, string>();
        for (const p of prs) {
            if (typeof p.merge_sha === "string" && typeof p.merged_at === "string") {
                mergedAtBySha.set(p.merge_sha, p.merged_at);
            }
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
