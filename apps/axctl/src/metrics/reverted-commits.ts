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
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { recordLiteral } from "@ax/lib/ids";
import { numOrNull, strOrNull } from "./util.ts";

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

// Mirrors the session-id validation in dashboard/session-view.ts so the
// record ref can be safely inlined. Normalization is the shared
// `toBareSessionId` (@ax/lib/shared/session-id); the charset gate stays local
// because it doubles as the inline-SQL safety check.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const sessionRecordRef = (sessionId: string): string | null => {
    const uuid = toBareSessionId(sessionId);
    return SESSION_ID_RE.test(uuid) ? `session:⟨${uuid}⟩` : null;
};

interface ProducedRow {
    readonly commit?: unknown;
    readonly sha?: unknown;
    readonly message?: unknown;
    readonly ts?: unknown;
    readonly reverted?: unknown;
}

interface FixRow {
    readonly feature?: unknown;
    readonly fix?: unknown;
    readonly fix_sha?: unknown;
    readonly fix_message?: unknown;
    readonly fix_ts?: unknown;
    readonly days_between?: unknown;
    readonly confidence?: unknown;
}

/**
 * Fetch the durability drill-down for one session. Returns null when the
 * session id fails validation (mirrors `session show`'s not-found handling -
 * the caller decides whether that is an error).
 */
export const fetchSessionDurabilityDetail = (
    sessionId: string,
): Effect.Effect<SessionDurabilityDetail | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const ref = sessionRecordRef(sessionId);
        if (ref === null) return null;
        const db = yield* SurrealClient;

        // 1. The session's produced commits (indexed produced_in_ts, capped).
        const produced = (yield* db.query<[ProducedRow[]]>(
            `SELECT type::string(out) AS commit, out.sha AS sha, out.message AS message,`
            + ` type::string(out.ts) AS ts, out.reverted AS reverted`
            + ` FROM produced WHERE in = ${ref} ORDER BY ts ASC LIMIT ${MAX_COMMITS};`,
        ))?.[0] ?? [];

        // De-dup (a commit can carry multiple produced edges across re-ingests).
        const byCommit = new Map<string, { sha: string | null; message: string | null; ts: string | null; reverted: boolean }>();
        for (const row of produced) {
            const commitId = strOrNull(row.commit);
            if (!commitId || byCommit.has(commitId)) continue;
            byCommit.set(commitId, {
                sha: strOrNull(row.sha),
                message: strOrNull(row.message),
                ts: strOrNull(row.ts),
                reverted: row.reverted === true,
            });
        }

        const revertedIds = [...byCommit.entries()].filter(([, c]) => c.reverted).map(([id]) => id);

        // 2. Fix chains for the reverted subset only (bounded IN-list over the
        //    small derived later_fixed_by table; out.* derefs run only on the
        //    matched edges).
        const fixesByFeature = new Map<string, FixingCommit[]>();
        if (revertedIds.length > 0) {
            const refs = revertedIds
                .map((id) => recordKeyPart(id, "commit"))
                .filter((k): k is string => k !== null)
                .map((k) => recordLiteral("commit", k))
                .join(", ");
            const fixRows = refs.length === 0 ? [] : (yield* db.query<[FixRow[]]>(
                `SELECT type::string(in) AS feature, type::string(out) AS fix,`
                + ` out.sha AS fix_sha, out.message AS fix_message, type::string(out.ts) AS fix_ts,`
                + ` days_between, confidence`
                + ` FROM later_fixed_by WHERE in IN [${refs}];`,
            ))?.[0] ?? [];
            for (const row of fixRows) {
                const feature = strOrNull(row.feature);
                const fix = strOrNull(row.fix);
                if (!feature || !fix) continue;
                const list = fixesByFeature.get(feature) ?? [];
                if (list.some((f) => f.commitId === fix)) continue;
                list.push({
                    commitId: fix,
                    sha: strOrNull(row.fix_sha),
                    message: strOrNull(row.fix_message),
                    ts: strOrNull(row.fix_ts),
                    daysBetween: numOrNull(row.days_between),
                    confidence: strOrNull(row.confidence),
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
