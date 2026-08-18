/**
 * Per-session durability drill-down (issue #176): the commits behind a
 * session's `durability_ratio` - which produced commits died (`commit.reverted`)
 * and what replaced them (`later_fixed_by` feature → fix chains).
 *
 * BOUNDED by design: every query is anchored on the single session's
 * `produced` edges (indexed `produced_in_ts`, capped at {@link MAX_COMMITS}),
 * and the fix lookup filters `later_fixed_by` (a small, derived table) by the
 * session's own reverted-commit ids - never a graph-wide walk, never per-edge
 * derefs over the big `invoked`/`edited` edge sets (see docs/metrics.md).
 *
 * Known gap, surfaced to the caller: `commit.reverted` is recomputed over FULL
 * history, but closure rebuilds `later_fixed_by` window-bounded - so a
 * reverted commit may carry no fix edge when its fix landed outside the last
 * ingest window. Renderers should show "fix outside ingest window" rather than
 * pretending the commit was never fixed.
 */
import { Effect, Schema } from "effect";
import { inClause } from "@ax/lib/duckdb/clause";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { toBareSessionId } from "@ax/lib/shared/session-id";

/** Cap on produced edges read per session (matches the timeline query cap). */
const MAX_COMMITS = 200;

export interface FixingCommit {
    readonly commitId: string;
    readonly sha: string | null;
    readonly message: string | null;
    readonly ts: string | null;
    readonly daysBetween: number | null;
    readonly confidence: string | null;
}

export interface RevertedCommitDetail {
    readonly commitId: string;
    readonly sha: string | null;
    readonly message: string | null;
    readonly ts: string | null;
    /** Fix-chain commits (`later_fixed_by` out-edges). Empty when the fix
     *  landed outside the closure ingest window. */
    readonly fixes: ReadonlyArray<FixingCommit>;
}

export interface SessionDurabilityDetail {
    readonly producedCommits: number;
    readonly revertedCommits: number;
    /** (produced - reverted) / produced; null when nothing was produced
     *  (unknown, distinct from 0 - mirrors `durability.ts`). */
    readonly durabilityRatio: number | null;
    readonly reverted: ReadonlyArray<RevertedCommitDetail>;
}

// Mirrors the session-id validation in dashboard/session-view.ts.
// DuckDB stores the bare provider session id.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const validatedSessionId = (sessionId: string): string | null => {
    const uuid = toBareSessionId(sessionId);
    return SESSION_ID_RE.test(uuid) ? uuid : null;
};

const ProducedRow = Schema.Struct({ commit: Schema.String, sha: Schema.NullOr(Schema.String), message: Schema.NullOr(Schema.String), ts: TimestampColumn, reverted: Schema.NullOr(Schema.Boolean) });
const FixRow = Schema.Struct({ feature: Schema.String, fix: Schema.String, fix_sha: Schema.NullOr(Schema.String), fix_message: Schema.NullOr(Schema.String), fix_ts: TimestampColumn, days_between: Schema.NullOr(Schema.Number), confidence: Schema.NullOr(Schema.String) });

/**
 * Fetch the durability drill-down for one session. Returns null when the
 * session id fails validation (mirrors `session show`'s not-found handling -
 * the caller decides whether that is an error).
 */
export const fetchSessionDurabilityDetail = (
    sessionId: string,
): Effect.Effect<SessionDurabilityDetail | null, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const ref = validatedSessionId(sessionId);
        if (ref === null) return null;
        const cache = yield* CacheRead;

        // 1. The session's produced commits (indexed produced_in_ts, capped).
        const produced = yield* cache.rows(
            ProducedRow,
            `SELECT c.id AS commit, c.sha, c.message, c.ts, c.reverted
             FROM produced p JOIN "commit" c ON c.id = p.out_id
             WHERE p.in_id = ? ORDER BY c.ts ASC LIMIT ?`,
            [ref, MAX_COMMITS],
        );

        // De-dup (a commit can carry multiple produced edges across re-ingests).
        const byCommit = new Map<string, { sha: string | null; message: string | null; ts: string | null; reverted: boolean }>();
        for (const row of produced) {
            const commitId = row.commit;
            if (byCommit.has(commitId)) continue;
            byCommit.set(commitId, {
                sha: row.sha,
                message: row.message,
                ts: row.ts.toISOString(),
                reverted: row.reverted === true,
            });
        }

        const revertedIds = [...byCommit.entries()].filter(([, c]) => c.reverted).map(([id]) => id);

        // 2. Fix chains for the reverted subset only (bounded IN-list over the
        //    small derived later_fixed_by table; out.* derefs run only on the
        //    matched edges).
        const fixesByFeature = new Map<string, FixingCommit[]>();
        if (revertedIds.length > 0) {
            const clause = inClause("l.in_id", revertedIds);
            const fixRows = yield* cache.rows(
                FixRow,
                `SELECT l.in_id AS feature, l.out_id AS fix, c.sha AS fix_sha,
                        c.message AS fix_message, c.ts AS fix_ts, l.days_between, l.confidence
                 FROM later_fixed_by l JOIN "commit" c ON c.id = l.out_id
                 WHERE TRUE ${clause.sql}`,
                clause.params,
            );
            for (const row of fixRows) {
                const feature = row.feature;
                const fix = row.fix;
                const list = fixesByFeature.get(feature) ?? [];
                if (list.some((f) => f.commitId === fix)) continue;
                list.push({
                    commitId: fix,
                    sha: row.fix_sha,
                    message: row.fix_message,
                    ts: row.fix_ts.toISOString(),
                    daysBetween: row.days_between,
                    confidence: row.confidence,
                });
                fixesByFeature.set(feature, list);
            }
            for (const list of fixesByFeature.values()) {
                list.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
            }
        }

        const reverted: RevertedCommitDetail[] = revertedIds.map((commitId) => {
            const c = byCommit.get(commitId)!;
            return {
                commitId,
                sha: c.sha,
                message: c.message,
                ts: c.ts,
                fixes: fixesByFeature.get(commitId) ?? [],
            };
        });

        const producedCount = byCommit.size;
        return {
            producedCommits: producedCount,
            revertedCommits: reverted.length,
            durabilityRatio: producedCount === 0 ? null : (producedCount - reverted.length) / producedCount,
            reverted,
        };
    });
