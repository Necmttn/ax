/**
 * Recent-sessions index for the dashboard. Powers `/api/sessions` and the
 * `/sessions` SPA route.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type { SessionListResponse, SessionListRow } from "../lib/shared/dashboard-types.ts";

export interface SessionsListOpts {
    readonly limit?: number;
    readonly source?: string;       // 'claude' | 'codex'
    readonly project?: string;
}

interface RawRow {
    readonly id: string;
    readonly project: string | null;
    readonly source: string | null;
    readonly cwd: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly has_raw_file: boolean;
    readonly turn_count: number;
}

const safeLiteral = (value: string): string => {
    if (value.includes("'")) throw new Error(`sessions-list: filter value contains a single quote: ${value}`);
    return `'${value}'`;
};

export const fetchSessionsList = (opts: SessionsListOpts = {}): Effect.Effect<SessionListResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
        const filters: string[] = ["started_at IS NOT NONE"];
        if (opts.source) filters.push(`source = ${safeLiteral(opts.source)}`);
        if (opts.project) filters.push(`project = ${safeLiteral(opts.project)}`);
        const whereClause = `WHERE ${filters.join(" AND ")}`;
        // Per-row subqueries against `turn` deadlock at scale (same anti-
        // pattern that bit loadPriorFileSessions). Fetch the session-only
        // columns first, then batch-count turns via one grouped query.
        const [rows] = yield* db.query<[Omit<RawRow, "turn_count">[]]>(`
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
            LIMIT ${limit};
        `);

        // Look up parent → child via the `spawned` relation so the SPA can
        // group subagent sessions under the session that spawned them. Cheap:
        // single batched IN-list query against a relation table.
        const sessionIds = rows.map((r) => r.id).filter(Boolean);
        const parentBySession = new Map<string, string>();
        if (sessionIds.length > 0) {
            const [edges] = yield* db.query<[Array<{ child: string; parent: string }>]>(`
                SELECT <string>out AS child, <string>in AS parent
                FROM spawned
                WHERE out IN [${sessionIds.join(", ")}];
            `);
            for (const e of edges) parentBySession.set(e.child, e.parent);
        }

        const sessions: SessionListRow[] = rows.map((r): SessionListRow => ({
            id: r.id,
            project: r.project,
            source: r.source ?? "unknown",
            cwd: r.cwd,
            model: r.model,
            started_at: r.started_at,
            ended_at: r.ended_at,
            has_raw_file: !!r.has_raw_file,
            turn_count: 0,
            parent_session: parentBySession.get(r.id) ?? null,
        }));

        // Parent-stub hydration: when a child's parent is outside the page
        // window, the SPA can't nest it under that parent. Fetch minimal
        // stubs so grouping works across windows. Cheap: one IN-list query.
        const inWindow = new Set(sessionIds);
        // Bounded by |window|: at most ~limit distinct missing parents per page.
        const missingParents = new Set<string>();
        for (const childParent of parentBySession.values()) {
            if (!inWindow.has(childParent)) missingParents.add(childParent);
        }
        const stubs: SessionListRow[] = [];
        if (missingParents.size > 0) {
            const ids = [...missingParents];
            // Stub fetch deliberately ignores source/project filters: a parent in a different source must still appear so its in-window children can group.
            const [stubRows] = yield* db.query<[Omit<RawRow, "turn_count">[]]>(`
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
                WHERE id IN [${ids.join(", ")}];
            `);
            for (const r of stubRows) {
                stubs.push({
                    id: r.id,
                    project: r.project,
                    source: r.source ?? "unknown",
                    cwd: r.cwd,
                    model: r.model,
                    started_at: r.started_at,
                    ended_at: r.ended_at,
                    has_raw_file: !!r.has_raw_file,
                    turn_count: 0,
                    parent_session: null,
                    is_stub: true,
                });
            }
        }

        // turn_count is intentionally NOT joined here: the cross-session turn
        // table is huge and a batched IN-list count still takes ~8 s at the
        // 200-row scale we want. Surface 0 in the wire format and let the
        // per-session detail view fetch it on demand. A materialised
        // session_summary view (TBD) will let us bring this back cheaply.
        return { sessions, parent_stubs: stubs };
    });
