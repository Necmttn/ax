/**
 * Checkout-activity + git-correlation overview, rebuilt deref-free.
 *
 * The legacy SurrealQL (queries/insights.ts checkoutActivitySql/gitCorrelationSql)
 * ran correlated per-row subqueries with record derefs - e.g.
 * `(SELECT id FROM turn WHERE session.checkout = $parent.id)` is a full turn
 * scan WITH a session deref per turn, repeated once per checkout. On a
 * year-old graph that is 50+ seconds and the daemon's 60s idleTimeout kills
 * the response. This module computes single-pass GROUP BY aggregates
 * (~1s total) and joins them in JS, preserving the legacy row shapes.
 *
 * Same class of fix as the skills-weighted hang: keep aggregates deref-free,
 * join in JS (see memory: weighted-query-per-edge-deref-hang).
 *
 * PORTED TO DUCKDB (Surreal -> DuckDB):
 *  - `repository.name`/`repository.remote_url` derefs on `checkout` became a
 *    real `LEFT JOIN repository`.
 *  - `array::len(->has_checkout->checkout)` (an edge table DuckDB does not
 *    have - `checkout` carries a plain `repository` FK) became a correlated
 *    COUNT subquery.
 *  - `produced.in`/`produced.out` and `touched.in`/`touched.out` became
 *    `in_id`/`out_id` (DuckDB's plain-FK column names for what were Surreal
 *    edge endpoints).
 *  - Every `count()` decodes through `NumberFromBigIntColumn` - a DuckDB
 *    `count(*)` is a BIGINT and a `Schema.Number` on it is a decode FAILURE
 *    (silently empty rows under the defensive read policy), not an error.
 *  - 12 independent statements, run concurrently through `CacheRead`; the JS
 *    aggregation/join logic below is unchanged from the previous engine.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { CacheRead } from "@ax/lib/duckdb/seam";

export interface WorktreesOverview {
    readonly activity: ReadonlyArray<Record<string, unknown>>;
    readonly git: ReadonlyArray<Record<string, unknown>>;
}

interface GroupRow { readonly n: number; readonly [key: string]: unknown }

const keyOf = (value: unknown): string => String(value);

/** Build `String(group key) -> count` from GROUP BY rows. */
function countMap(rows: ReadonlyArray<GroupRow>, key: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
        const k = row[key];
        if (k != null) map.set(keyOf(k), row.n);
    }
    return map;
}

const lastSeenOf = (row: Record<string, unknown>): string => {
    const v = row.updated_at ?? row.created_at;
    return v instanceof Date ? v.toISOString() : String(v ?? "");
};

const byCounts = (keys: ReadonlyArray<string>) =>
(a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const k of keys) {
        const d = ((b[k] as number) ?? 0) - ((a[k] as number) ?? 0);
        if (d !== 0) return d;
    }
    return lastSeenOf(b).localeCompare(lastSeenOf(a));
};

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const NullableText = Schema.NullOr(Schema.String);
const NullableTimestamp = Schema.NullOr(TimestampColumn);

const CheckoutRow = Schema.Struct({
    id: Schema.String,
    repository: NullableText,
    repository_name: NullableText,
    remote_url: NullableText,
    path: Schema.String,
    branch: NullableText,
    worktree_name: NullableText,
    head_sha: NullableText,
    dirty: Schema.Boolean,
    created_at: NullableTimestamp,
    updated_at: NullableTimestamp,
    last_seen: NullableTimestamp,
});

const RepositoryRow = Schema.Struct({
    id: Schema.String,
    name: NullableText,
    remote_url: NullableText,
    root_path: NullableText,
    created_at: NullableTimestamp,
    updated_at: NullableTimestamp,
    last_seen: NullableTimestamp,
    checkout_count: NumberFromBigIntColumn,
});

const SessionRow = Schema.Struct({
    id: Schema.String,
    checkout: NullableText,
    repository: NullableText,
});

const GroupCountRow = (keyColumn: string) =>
    Schema.Struct({ [keyColumn]: NullableText, n: NumberFromBigIntColumn });

const CommitRow = Schema.Struct({ id: Schema.String, repository: NullableText });

const ProducedCheckoutRow = Schema.Struct({ out: Schema.String, checkout: NullableText });

/** ISO string or null, from a decoded TIMESTAMP column. Mirrors the row shape
 *  the JS aggregation logic below expects (a `Date | undefined` it re-stringifies
 *  via `lastSeenOf`). */
const toRow = <T extends Record<string, unknown>>(row: T): Record<string, unknown> => ({ ...row });

export const fetchWorktreesOverview = (
    limit = 50,
): Effect.Effect<WorktreesOverview, never, CacheRead> =>
    Effect.gen(function* () {
        const [
            checkouts,
            repositories,
            sessions,
            turnsBySession,
            toolCallsBySession,
            toolFailuresBySession,
            producedBySession,
            producedByCommit,
            touchedByCommit,
            commitsByRepo,
            commits,
            producedCheckouts,
        ] = yield* Effect.all(
            [
                cacheRows(
                    CheckoutRow,
                    {
                        sql: `SELECT c.id AS id, c.repository AS repository, r.name AS repository_name,
                                     r.remote_url AS remote_url, c.path AS path, c.branch AS branch,
                                     c.worktree_name AS worktree_name, c.head_sha AS head_sha, c.dirty AS dirty,
                                     c.created_at AS created_at, c.updated_at AS updated_at,
                                     COALESCE(c.updated_at, c.created_at) AS last_seen
                              FROM checkout c LEFT JOIN repository r ON r.id = c.repository`,
                        params: [],
                    },
                    "worktrees-overview.checkouts",
                ),
                cacheRows(
                    RepositoryRow,
                    {
                        sql: `SELECT r.id AS id, r.name AS name, r.remote_url AS remote_url, r.root_path AS root_path,
                                     r.created_at AS created_at, r.updated_at AS updated_at,
                                     COALESCE(r.updated_at, r.created_at) AS last_seen,
                                     (SELECT count(*) FROM checkout c2 WHERE c2.repository = r.id) AS checkout_count
                              FROM repository r`,
                        params: [],
                    },
                    "worktrees-overview.repositories",
                ),
                cacheRows(SessionRow, { sql: "SELECT id, checkout, repository FROM session", params: [] }, "worktrees-overview.sessions"),
                cacheRows(GroupCountRow("session"), { sql: "SELECT session, count(*) AS n FROM turn GROUP BY session", params: [] }, "worktrees-overview.turns_by_session"),
                cacheRows(GroupCountRow("session"), { sql: "SELECT session, count(*) AS n FROM tool_call GROUP BY session", params: [] }, "worktrees-overview.tool_calls_by_session"),
                cacheRows(GroupCountRow("session"), { sql: "SELECT session, count(*) AS n FROM tool_call WHERE has_error = true GROUP BY session", params: [] }, "worktrees-overview.tool_failures_by_session"),
                cacheRows(GroupCountRow("in"), { sql: 'SELECT in_id AS "in", count(*) AS n FROM produced GROUP BY in_id', params: [] }, "worktrees-overview.produced_by_session"),
                cacheRows(GroupCountRow("out"), { sql: 'SELECT out_id AS "out", count(*) AS n FROM produced GROUP BY out_id', params: [] }, "worktrees-overview.produced_by_commit"),
                cacheRows(GroupCountRow("in"), { sql: 'SELECT in_id AS "in", count(*) AS n FROM touched GROUP BY in_id', params: [] }, "worktrees-overview.touched_by_commit"),
                cacheRows(GroupCountRow("repository"), { sql: 'SELECT repository, count(*) AS n FROM "commit" WHERE repository IS NOT NULL GROUP BY repository', params: [] }, "worktrees-overview.commits_by_repo"),
                cacheRows(CommitRow, { sql: 'SELECT id, repository FROM "commit"', params: [] }, "worktrees-overview.commits"),
                cacheRows(ProducedCheckoutRow, { sql: 'SELECT out_id AS "out", checkout FROM produced WHERE checkout IS NOT NULL', params: [] }, "worktrees-overview.produced_checkouts"),
            ],
            { concurrency: 4 },
        );

        const turnsPerSession = countMap(turnsBySession as unknown as GroupRow[], "session");
        const toolCallsPerSession = countMap(toolCallsBySession as unknown as GroupRow[], "session");
        const toolFailuresPerSession = countMap(toolFailuresBySession as unknown as GroupRow[], "session");
        const producedPerSession = countMap(producedBySession as unknown as GroupRow[], "in");
        const producedPerCommit = countMap(producedByCommit as unknown as GroupRow[], "out");
        const touchedPerCommit = countMap(touchedByCommit as unknown as GroupRow[], "in");
        const commitsPerRepo = countMap(commitsByRepo as unknown as GroupRow[], "repository");

        // Roll commit-grouped touched/produced counts up to checkout + repo.
        // A commit's checkout comes from its produced edge (first one wins
        // when several sessions produced the same commit).
        const checkoutPerCommit = new Map<string, string>();
        for (const edge of producedCheckouts) {
            const ckey = keyOf(edge.out);
            if (!checkoutPerCommit.has(ckey) && edge.checkout != null) {
                checkoutPerCommit.set(ckey, keyOf(edge.checkout));
            }
        }
        const touchedPerCheckout = new Map<string, number>();
        const touchedPerRepo = new Map<string, number>();
        const producedPerRepo = new Map<string, number>();
        for (const commit of commits) {
            const ckey = keyOf(commit.id);
            const touched = touchedPerCommit.get(ckey) ?? 0;
            const produced = producedPerCommit.get(ckey) ?? 0;
            const checkout = checkoutPerCommit.get(ckey);
            if (checkout !== undefined && touched > 0) {
                touchedPerCheckout.set(checkout, (touchedPerCheckout.get(checkout) ?? 0) + touched);
            }
            if (commit.repository != null) {
                const rk = keyOf(commit.repository);
                if (touched > 0) touchedPerRepo.set(rk, (touchedPerRepo.get(rk) ?? 0) + touched);
                if (produced > 0) producedPerRepo.set(rk, (producedPerRepo.get(rk) ?? 0) + produced);
            }
        }

        // Sessions roll up to their checkout and repository.
        const sessionsPerCheckout = new Map<string, string[]>();
        const sessionsPerRepo = new Map<string, number>();
        const checkoutSessionsPerRepo = new Map<string, number>();
        for (const session of sessions) {
            const sid = keyOf(session.id);
            if (session.checkout != null) {
                const ck = keyOf(session.checkout);
                const list = sessionsPerCheckout.get(ck) ?? [];
                list.push(sid);
                sessionsPerCheckout.set(ck, list);
            }
            if (session.repository != null) {
                const rk = keyOf(session.repository);
                sessionsPerRepo.set(rk, (sessionsPerRepo.get(rk) ?? 0) + 1);
                if (session.checkout != null) {
                    checkoutSessionsPerRepo.set(rk, (checkoutSessionsPerRepo.get(rk) ?? 0) + 1);
                }
            }
        }
        const sumOver = (sids: ReadonlyArray<string>, map: Map<string, number>): number =>
            sids.reduce((acc, sid) => acc + (map.get(sid) ?? 0), 0);

        const activity = checkouts
            .map((checkout) => {
                const ck = keyOf(checkout.id);
                const sids = sessionsPerCheckout.get(ck) ?? [];
                return {
                    ...toRow(checkout),
                    session_count: sids.length,
                    turn_count: sumOver(sids, turnsPerSession),
                    tool_call_count: sumOver(sids, toolCallsPerSession),
                    tool_failure_count: sumOver(sids, toolFailuresPerSession),
                    produced_count: sumOver(sids, producedPerSession),
                    touched_count: touchedPerCheckout.get(ck) ?? 0,
                };
            })
            .sort(byCounts(["session_count", "turn_count", "produced_count"]))
            .slice(0, limit);

        const git = repositories
            .map((repo) => {
                const rk = keyOf(repo.id);
                return {
                    ...toRow(repo),
                    session_count: sessionsPerRepo.get(rk) ?? 0,
                    checkout_linked_session_count: checkoutSessionsPerRepo.get(rk) ?? 0,
                    commit_count: commitsPerRepo.get(rk) ?? 0,
                    touched_count: touchedPerRepo.get(rk) ?? 0,
                    produced_count: producedPerRepo.get(rk) ?? 0,
                };
            })
            .sort(byCounts(["session_count", "produced_count", "commit_count"]))
            .slice(0, limit);

        return { activity, git };
    });
