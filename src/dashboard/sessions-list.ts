/**
 * Recent-sessions index for the dashboard. Powers `/api/sessions` (roots
 * only) + `/api/sessions/:id/children` (direct children) and the `/sessions`
 * SPA route.
 *
 * Tree contract: `/api/sessions` returns ROOTS - sessions with no inbound
 * `spawned` edge - paginated by started_at DESC. The SPA lazy-fetches a
 * root's direct children via `/api/sessions/:id/children` when the user
 * expands a row.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type {
    SessionChildrenResponse,
    SessionListResponse,
    SessionListRow,
} from "../lib/shared/dashboard-types.ts";
import { clampPagination, type PaginationConfig } from "../lib/shared/pagination.ts";
import { toBareSessionId, toSessionRid } from "../lib/shared/session-id.ts";

export interface SessionsListOpts {
    readonly offset?: number;
    readonly limit?: number;
    readonly source?: string;       // 'claude' | 'codex'
    readonly project?: string;
}

export interface SessionChildrenOpts {
    /** Hard cap on returned children. Heaviest observed fan-out is ~390;
     *  default 500 leaves headroom without risking unbounded payloads. */
    readonly limit?: number;
}

const SESSIONS_PAGINATION: PaginationConfig = { defaultLimit: 200, maxLimit: 500 };
/** Hard cap on the per-parent children endpoint. NOT a pagination axis -
 *  callers fetch all children in one shot; this just prevents runaway
 *  payloads if fan-out ever spikes past observed ceilings. */
const MAX_CHILDREN = 1000;

interface RawRow {
    readonly id: string;
    readonly project: string | null;
    readonly source: string | null;
    readonly cwd: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly has_raw_file: boolean;
}

const safeLiteral = (value: string): string => {
    if (value.includes("'")) throw new Error(`sessions-list: filter value contains a single quote: ${value}`);
    return `'${value}'`;
};

/**
 * Surreal record-id literal IN-list. The ids here come straight out of
 * `<string>id` casts (already `session:\`uuid\`` form) and are interpolated
 * into SurrealQL as record-link comparators, so we don't double-quote them.
 * Bare ids in DTOs go through `toSessionRid` before reaching this helper.
 */
const formatRecordIdList = (ids: ReadonlyArray<string>): string => ids.join(", ");

export const fetchSessionsList = (opts: SessionsListOpts = {}): Effect.Effect<SessionListResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const { offset, limit } = clampPagination(
            { offset: opts.offset, limit: opts.limit },
            SESSIONS_PAGINATION,
        );
        // Roots-only filter: `!<-spawned` evaluates the graph traversal and
        // returns truthy when this session has zero inbound spawned edges.
        // Index `spawned_out` (on `spawned.out`) makes this cheap. Verified
        // <250ms over 5.4k sessions / 2.3k edges.
        const filters: string[] = ["started_at IS NOT NONE", "!<-spawned"];
        if (opts.source) filters.push(`source = ${safeLiteral(opts.source)}`);
        if (opts.project) filters.push(`project = ${safeLiteral(opts.project)}`);
        const whereClause = `WHERE ${filters.join(" AND ")}`;
        // Per-row subqueries against `turn` deadlock at scale (same anti-
        // pattern that bit loadPriorFileSessions). Fetch the session-only
        // columns first, then batch-count subagent fan-out via one grouped
        // query against `spawned`. The count query reuses the same WHERE
        // filter set so the answer is stable across pages. Run as a single
        // multi-statement query: the shared SurrealDB websocket interleaves
        // independent .query() calls badly, so issuing both in one round-trip
        // keeps the response framing aligned.
        const [rows, countRows] = yield* db.query<[RawRow[], Array<{ total: number }>]>(`
            SELECT
                <string>id AS id,
                project,
                source,
                cwd,
                model,
                <string>started_at AS started_at,
                <string>ended_at AS ended_at,
                raw_file != NONE AS has_raw_file
            FROM session
            ${whereClause}
            ORDER BY started_at DESC
            START ${offset} LIMIT ${limit};
            SELECT count() AS total
            FROM session
            ${whereClause}
            GROUP ALL;
        `);

        // Single grouped query against `spawned` gives us the direct-child
        // count per visible root. Lets the SPA render the expand toggle +
        // "K with subagents" metric without per-row fan-out fetches.
        const rootIds = rows.map((r) => r.id).filter(Boolean);
        const childCountByRoot = new Map<string, number>();
        if (rootIds.length > 0) {
            const [counts] = yield* db.query<[Array<{ parent: string; c: number }>]>(`
                SELECT <string>in AS parent, count() AS c
                FROM spawned
                WHERE in IN [${formatRecordIdList(rootIds)}]
                GROUP BY parent;
            `);
            for (const r of counts) childCountByRoot.set(r.parent, Number(r.c) || 0);
        }

        // Bare ids cross the HTTP seam; record-id form is kept only for the
        // childCountByRoot lookup (whose keys were also raw record-id strings
        // from `<string>in AS parent`). See src/lib/shared/session-id.ts.
        const sessions: SessionListRow[] = rows.map((r): SessionListRow => ({
            id: toBareSessionId(r.id),
            project: r.project,
            source: r.source ?? "unknown",
            cwd: r.cwd,
            model: r.model,
            started_at: r.started_at,
            ended_at: r.ended_at,
            has_raw_file: !!r.has_raw_file,
            // turn_count intentionally NOT joined here: the cross-session
            // turn table is huge and a batched IN-list count still takes
            // ~8 s at the 200-row scale we want. Surface 0 in the wire
            // format; per-session detail view fetches it on demand.
            turn_count: 0,
            parent_session: null,
            direct_children_count: childCountByRoot.get(r.id) ?? 0,
        }));

        const countRow = countRows?.[0];
        const totalFromCount = countRow ? Number(countRow.total ?? 0) : 0;
        // why: same defence as recall.ts - the count query can legitimately
        // return 0 (empty row, GROUP ALL on empty filter set, or a race with
        // a concurrent ingest). Falling back to `sessions.length + offset`
        // keeps the UI from claiming fewer rows than it just rendered.
        const total_count = Math.max(
            Number.isFinite(totalFromCount) ? Math.trunc(totalFromCount) : 0,
            sessions.length + offset,
        );

        return { sessions, total_count, window: { offset, limit } };
    });

/**
 * Direct children of `parentId` (one level only, NOT a recursive descent).
 * Used by `/api/sessions/:id/children` when the SPA expands a root row.
 *
 * Accepts the bare URL-form session id (UUID / claude-subagent-...);
 * normalises to a Surreal record id internally via `toSessionRid` and emits
 * bare ids back over HTTP via `toBareSessionId`.
 *
 * Ordered started_at ASC so children read top→bottom in spawn order, which
 * matches what the inspector's spawned-child list does.
 */
// Pagination deferred: heaviest observed fan-out ~390; 500 default covers the practical case. Add offset if needed.
export const fetchSessionChildren = (
    parentBareId: string,
    opts: SessionChildrenOpts = {},
): Effect.Effect<SessionChildrenResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = Math.max(1, Math.min(opts.limit ?? 500, MAX_CHILDREN));
        const parent_session = toBareSessionId(parentBareId);
        const parentRid = toSessionRid(parent_session);
        // Two-step: fetch child record ids from `spawned`, then materialise
        // the child session rows. Avoids a nested subquery that Surreal can
        // mis-bind, and matches the existing IN-list pattern used elsewhere
        // in this module. Both queries are index-backed (`spawned_in`).
        const [edges] = yield* db.query<[Array<{ child: string }>]>(`
            SELECT <string>out AS child FROM spawned WHERE in = ${parentRid};
        `);
        const childIds = edges.map((e) => e.child).filter(Boolean);
        if (childIds.length === 0) {
            return { parent_session, children: [] };
        }
        const [rows] = yield* db.query<[RawRow[]]>(`
            SELECT
                <string>id AS id,
                project,
                source,
                cwd,
                model,
                <string>started_at AS started_at,
                <string>ended_at AS ended_at,
                raw_file != NONE AS has_raw_file
            FROM session
            WHERE id IN [${formatRecordIdList(childIds)}]
            ORDER BY started_at ASC
            LIMIT ${limit};
        `);

        const children: SessionListRow[] = rows.map((r): SessionListRow => ({
            id: toBareSessionId(r.id),
            project: r.project,
            source: r.source ?? "unknown",
            cwd: r.cwd,
            model: r.model,
            started_at: r.started_at,
            ended_at: r.ended_at,
            has_raw_file: !!r.has_raw_file,
            turn_count: 0,
            parent_session,
        }));

        return { parent_session, children };
    });
