/**
 * Checkout-activity + git-correlation overview, rebuilt deref-free.
 *
 * The legacy SQL (queries/insights.ts checkoutActivitySql/gitCorrelationSql)
 * ran correlated per-row subqueries with record derefs - e.g.
 * `(SELECT id FROM turn WHERE session.checkout = $parent.id)` is a full turn
 * scan WITH a session deref per turn, repeated once per checkout. On a
 * year-old graph that is 50+ seconds and the daemon's 60s idleTimeout kills
 * the response. This module computes single-pass GROUP BY aggregates
 * (~1s total) and joins them in JS, preserving the legacy row shapes.
 *
 * Same class of fix as the skills-weighted hang: keep aggregates deref-free,
 * join in JS (see memory: weighted-query-per-edge-deref-hang).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

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

export const fetchWorktreesOverview = (
    limit = 50,
): Effect.Effect<WorktreesOverview, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [
            [checkouts],
            [repositories],
            [sessions],
            [turnsBySession],
            [toolCallsBySession],
            [toolFailuresBySession],
            [producedBySession],
            [producedByCommit],
            [touchedByCommit],
            [commitsByRepo],
            [commits],
            [producedCheckouts],
        ] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(`
SELECT id, repository, repository.name AS repository_name, repository.remote_url AS remote_url,
    path, branch, worktree_name, head_sha, dirty, created_at, updated_at,
    (updated_at ?? created_at) AS last_seen
FROM checkout;`),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT id, name, remote_url, root_path, created_at, updated_at,
    (updated_at ?? created_at) AS last_seen,
    array::len(->has_checkout->checkout) AS checkout_count
FROM repository;`),
            db.query<[Array<Record<string, unknown>>]>(
                "SELECT id, checkout, repository FROM session;",
            ),
            db.query<[Array<GroupRow>]>("SELECT session, count() AS n FROM turn GROUP BY session;"),
            db.query<[Array<GroupRow>]>("SELECT session, count() AS n FROM tool_call GROUP BY session;"),
            db.query<[Array<GroupRow>]>(
                "SELECT session, count() AS n FROM tool_call WHERE has_error = true GROUP BY session;",
            ),
            db.query<[Array<GroupRow>]>("SELECT in, count() AS n FROM produced GROUP BY in;"),
            db.query<[Array<GroupRow>]>("SELECT out, count() AS n FROM produced GROUP BY out;"),
            // touched is the biggest table (~430k edges). Grouping by its
            // `checkout`/`repository` FIELDS materializes every row (~13s
            // each, with or without a secondary index - SurrealDB only
            // groups fast on the edge key `in`). So group by commit and roll
            // up through the commit's checkout/repository in JS; touched
            // edges inherit both from their commit at ingest.
            db.query<[Array<GroupRow>]>("SELECT in, count() AS n FROM touched GROUP BY in;"),
            db.query<[Array<GroupRow>]>(
                "SELECT repository, count() AS n FROM commit WHERE repository IS NOT NONE GROUP BY repository;",
            ),
            db.query<[Array<Record<string, unknown>>]>("SELECT id, repository FROM commit;"),
            // commit -> checkout linkage lives on produced edges (commit rows
            // carry checkout = NONE in practice); ~7k rows, cheap full pull.
            db.query<[Array<Record<string, unknown>>]>(
                "SELECT out, checkout FROM produced WHERE checkout IS NOT NONE;",
            ),
        ], { concurrency: 4 });

        const turnsPerSession = countMap(turnsBySession ?? [], "session");
        const toolCallsPerSession = countMap(toolCallsBySession ?? [], "session");
        const toolFailuresPerSession = countMap(toolFailuresBySession ?? [], "session");
        const producedPerSession = countMap(producedBySession ?? [], "in");
        const producedPerCommit = countMap(producedByCommit ?? [], "out");
        const touchedPerCommit = countMap(touchedByCommit ?? [], "in");
        const commitsPerRepo = countMap(commitsByRepo ?? [], "repository");

        // Roll commit-grouped touched/produced counts up to checkout + repo.
        // A commit's checkout comes from its produced edge (first one wins
        // when several sessions produced the same commit).
        const checkoutPerCommit = new Map<string, string>();
        for (const edge of producedCheckouts ?? []) {
            const ckey = keyOf(edge.out);
            if (!checkoutPerCommit.has(ckey) && edge.checkout != null) {
                checkoutPerCommit.set(ckey, keyOf(edge.checkout));
            }
        }
        const touchedPerCheckout = new Map<string, number>();
        const touchedPerRepo = new Map<string, number>();
        const producedPerRepo = new Map<string, number>();
        for (const commit of commits ?? []) {
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
        for (const session of sessions ?? []) {
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

        const activity = (checkouts ?? [])
            .map((checkout) => {
                const ck = keyOf(checkout.id);
                const sids = sessionsPerCheckout.get(ck) ?? [];
                return {
                    ...checkout,
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

        const git = (repositories ?? [])
            .map((repo) => {
                const rk = keyOf(repo.id);
                return {
                    ...repo,
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
