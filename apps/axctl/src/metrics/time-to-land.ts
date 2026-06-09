import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { isoMs, sessionRefList } from "./util.ts";

/**
 * Latency from a session's end to when its work landed: the earliest
 * `merged_at` over PRs whose `merge_sha` matches a commit the session
 * `produced`, minus `session.ended_at`, in ms. null when nothing merged.
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
        // Produced commits (sha) + the producing session's end time.
        const produced = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(in) AS session, type::string(in.ended_at) AS ended_at, out.sha AS sha`
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
            const endedMs = isoMs(r.ended_at);
            if (sha === null || endedMs === null) continue;
            const mergedAt = mergedAtBySha.get(sha);
            if (mergedAt === undefined) continue;
            const mergedMs = isoMs(mergedAt);
            if (mergedMs === null) continue;
            const ms = mergedMs - endedMs;
            const cur = best.get(session);
            if (cur === undefined || ms < cur) best.set(session, ms);
        }
        for (const [s, ms] of best) map.set(s, ms);
        return map;
    });
