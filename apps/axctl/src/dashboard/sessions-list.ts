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

import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb";
import { JsonArrayColumn, NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import type {
    SessionChildrenResponse,
    SessionListResponse,
    SessionListRow,
} from "@ax/lib/shared/dashboard-types";
import { clampPagination, type PaginationConfig } from "@ax/lib/shared/pagination";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { fetchSessionBaselines } from "./session-baselines.ts";

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

/** ended_at-null sessions count as live only when the health derive row was
 *  written recently - the watcher re-ingests live transcripts within ~1 min,
 *  so a stale ts means the session is dead, just never closed. */
// Wart: deep-backfill can mark old open sessions live/stale by rewriting
// session_health.ts, but health ts must stay fresh for the dashboard proxy.
const LIVE_HEALTH_TS_WINDOW_MS = 10 * 60_000;

interface HealthRow {
    readonly session: string;
    readonly turns: number | null;
    readonly tool_errors: number | null;
    readonly user_corrections: number | null;
    readonly context_pressure: string | null;
    readonly ts: Date | null;
}
interface UsageRow {
    readonly session: string;
    readonly estimated_cost_usd: number | null;
    readonly estimated_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly burn_buckets: ReadonlyArray<number> | null;
}
interface MetricsRow {
    readonly session: string;
    readonly produced_commits: number | null;
    readonly reverted_commits: number | null;
    readonly lines_added: number | null;
    readonly lines_removed: number | null;
}

const RawRowSchema = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(TimestampColumn),
    ended_at: Schema.NullOr(TimestampColumn),
    has_raw_file: Schema.Boolean,
});
const CountSchema = Schema.Struct({ total: NumberFromBigIntColumn });
const ChildCountSchema = Schema.Struct({ parent: Schema.String, c: NumberFromBigIntColumn });
const HealthSchema = Schema.Struct({ session: Schema.String, turns: Schema.NullOr(NumberFromBigIntColumn), tool_errors: Schema.NullOr(NumberFromBigIntColumn), user_corrections: Schema.NullOr(NumberFromBigIntColumn), context_pressure: Schema.NullOr(Schema.String), ts: Schema.NullOr(TimestampColumn) });
const UsageSchema = Schema.Struct({ session: Schema.String, estimated_cost_usd: Schema.NullOr(Schema.Number), estimated_tokens: Schema.NullOr(NumberFromBigIntColumn), cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn), burn_buckets: Schema.NullOr(JsonArrayColumn(Schema.Number)) });
const MetricsSchema = Schema.Struct({ session: Schema.String, produced_commits: Schema.NullOr(NumberFromBigIntColumn), reverted_commits: Schema.NullOr(NumberFromBigIntColumn), lines_added: Schema.NullOr(NumberFromBigIntColumn), lines_removed: Schema.NullOr(NumberFromBigIntColumn) });

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

export const fetchSessionsList = (opts: SessionsListOpts = {}): Effect.Effect<SessionListResponse, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const { offset, limit } = clampPagination(
            { offset: opts.offset, limit: opts.limit },
            SESSIONS_PAGINATION,
        );
        // Roots-only filter: `!<-spawned` evaluates the graph traversal and
        // returns truthy when this session has zero inbound spawned edges.
        // Index `spawned_out` (on `spawned.out`) makes this cheap. Verified
        // <250ms over 5.4k sessions / 2.3k edges.
        const filters: string[] = ["s.started_at IS NOT NULL", "NOT EXISTS (SELECT 1 FROM spawned e WHERE e.out_id = s.id)"];
        const filterParams: Array<string> = [];
        if (opts.source) { filters.push("s.source = ?"); filterParams.push(opts.source); }
        if (opts.project) { filters.push("s.project = ?"); filterParams.push(opts.project); }
        const whereClause = `WHERE ${filters.join(" AND ")}`;
        // Per-row subqueries against `turn` deadlock at scale (same anti-
        // pattern that bit loadPriorFileSessions). Fetch the session-only
        // columns first, then batch-count subagent fan-out via one grouped
        // query against `spawned`. The count query reuses the same WHERE
        // filter set so the answer is stable across pages.
        // Keep the cache row id during mapping for the batched edge and
        // aggregate queries. Only the bare id crosses the HTTP boundary.
        const [pageRows, countRows] = yield* Effect.all([
            db.rows(RawRowSchema, `
            SELECT
                s.id, s.project, s.source, s.cwd, s.model, s.started_at, s.ended_at,
                s.raw_file IS NOT NULL AS has_raw_file
            FROM session s
            ${whereClause}
            ORDER BY s.started_at DESC
            LIMIT ? OFFSET ?`, [...filterParams, limit, offset]),
            db.rows(CountSchema, `SELECT count(*) AS total FROM session s ${whereClause}`, filterParams),
        ]);
        const rawIdByBare = new Map<string, string>();
        const baseItems: SessionListRow[] = pageRows.map((r) => {
            const bareId = toBareSessionId(r.id);
            rawIdByBare.set(bareId, r.id);
            return {
                id: bareId, project: r.project, source: r.source ?? "unknown", cwd: r.cwd,
                model: r.model, started_at: r.started_at?.toISOString() ?? null,
                ended_at: r.ended_at?.toISOString() ?? null, has_raw_file: r.has_raw_file,
                turn_count: 0, parent_session: null, direct_children_count: 0,
                cost_usd: null, burn_buckets: null, friction: null, signal: null,
                produced_commits: null, reverted_commits: null, lines_added: null,
                lines_removed: null, is_live: false,
            };
        });
        const paged = { items: baseItems, total: countRows[0]?.total ?? 0 };
        // Single grouped query against `spawned` gives us the direct-child
        // count per visible root. Lets the SPA render the expand toggle +
        // "K with subagents" metric without per-row fan-out fetches.
        const rawIds = Array.from(rawIdByBare.values());
        const childCountByRawId = new Map<string, number>();
        if (rawIds.length > 0) {
            const counts = yield* db.rows(ChildCountSchema, `
                SELECT in_id AS parent, count(*) AS c
                FROM spawned
                WHERE in_id IN (${placeholders(rawIds.length)})
                GROUP BY in_id`, rawIds);
            for (const r of counts) {
                childCountByRawId.set(r.parent, Number(r.c) || 0);
            }
        }
        // Enrichment: one multi-statement round-trip against the three
        // per-session aggregate tables. All keyed `session IN [...]` on
        // UNIQUE session indexes - no turn scans, no graph derefs (the two
        // documented hang classes for this surface).
        const healthBySession = new Map<string, HealthRow>();
        const usageBySession = new Map<string, UsageRow>();
        const metricsBySession = new Map<string, MetricsRow>();
        if (rawIds.length > 0) {
            const inList = placeholders(rawIds.length);
            // enrichment must never break the base list - degrade to bare rows.
            const [health, usage, metrics] = yield* Effect.all([
                db.rows(HealthSchema, `SELECT session, turns, tool_errors,
                       user_corrections, context_pressure, ts
                FROM session_health WHERE session IN (${inList})`, rawIds),
                db.rows(UsageSchema, `SELECT session, estimated_cost_usd,
                       estimated_tokens, cache_read_input_tokens, burn_buckets
                FROM session_token_usage WHERE session IN (${inList})`, rawIds),
                db.rows(MetricsSchema, `SELECT session, produced_commits,
                       reverted_commits, lines_added, lines_removed
                FROM session_metrics WHERE session IN (${inList})`, rawIds),
            ]).pipe(Effect.catch(() => Effect.succeed([[], [], []] as const)));
            for (const h of health) healthBySession.set(h.session, h);
            for (const u of usage) usageBySession.set(u.session, u);
            for (const m of metrics) metricsBySession.set(m.session, m);
        }

        const now = Date.now();
        const sessions: SessionListRow[] = paged.items.map((s) => {
            const rawId = rawIdByBare.get(s.id) ?? "";
            const health = healthBySession.get(rawId);
            const usage = usageBySession.get(rawId);
            const metrics = metricsBySession.get(rawId);
            const friction = health
                ? (Number(health.user_corrections) || 0) + (Number(health.tool_errors) || 0)
                : null;
            const healthTs = health?.ts ? new Date(health.ts).getTime() : Number.NaN;
            return {
                ...s,
                direct_children_count: childCountByRawId.get(rawId) ?? 0,
                turn_count: health?.turns ?? 0,
                cost_usd: usage?.estimated_cost_usd ?? null,
                burn_buckets: usage?.burn_buckets ? [...usage.burn_buckets] : null,
                friction,
                signal: friction === null ? null : friction === 0 ? "clean" : "friction",
                produced_commits: metrics?.produced_commits ?? null,
                reverted_commits: metrics?.reverted_commits ?? null,
                lines_added: metrics?.lines_added ?? null,
                lines_removed: metrics?.lines_removed ?? null,
                is_live: s.ended_at === null
                    && Number.isFinite(healthTs)
                    && now - healthTs < LIVE_HEALTH_TS_WINDOW_MS,
            };
        });

        // why: same defence as recall.ts - the count query can legitimately
        // return 0 (empty row, GROUP ALL on empty filter set, or a race with
        // a concurrent ingest). Falling back to `sessions.length + offset`
        // keeps the UI from claiming fewer rows than it just rendered.
        const total_count = Math.max(paged.total, sessions.length + offset);
        const baselines = yield* fetchSessionBaselines().pipe(
            Effect.catch(() => Effect.succeed(null)),
        );

        return { sessions, total_count, burn_p90: baselines?.burn_p90 ?? null, window: { offset, limit } };
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
): Effect.Effect<SessionChildrenResponse, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const limit = Math.max(1, Math.min(opts.limit ?? 500, MAX_CHILDREN));
        const parent_session = toBareSessionId(parentBareId);
        // Two-step: fetch child record ids from `spawned`, then materialise
        // the child session rows. Avoids a nested subquery that Surreal can
        // mis-bind, and matches the existing IN-list pattern used elsewhere
        // in this module. Both queries are index-backed (`spawned_in`).
        const EdgeSchema = Schema.Struct({ child: Schema.String });
        const edges = yield* db.rows(EdgeSchema, "SELECT out_id AS child FROM spawned WHERE in_id = ?", [parent_session]);
        const childIds = edges.map((e) => e.child).filter(Boolean);
        if (childIds.length === 0) {
            return { parent_session, children: [] };
        }
        const rows = yield* db.rows(RawRowSchema, `
            SELECT
                id, project, source, cwd, model, started_at, ended_at,
                raw_file IS NOT NULL AS has_raw_file
            FROM session
            WHERE id IN (${placeholders(childIds.length)})
            ORDER BY started_at ASC
            LIMIT ?`, [...childIds, limit]);

        const children: SessionListRow[] = rows.map((r): SessionListRow => ({
            id: toBareSessionId(r.id),
            // coalesce NONE/undefined → null to satisfy NullOr(String) (see fetchSessionsList)
            project: r.project ?? null,
            source: r.source ?? "unknown",
            cwd: r.cwd ?? null,
            model: r.model ?? null,
            started_at: r.started_at?.toISOString() ?? null,
            ended_at: r.ended_at?.toISOString() ?? null,
            has_raw_file: !!r.has_raw_file,
            turn_count: 0,
            parent_session,
            cost_usd: null,
            burn_buckets: null,
            friction: null,
            signal: null,
            produced_commits: null,
            reverted_commits: null,
            lines_added: null,
            lines_removed: null,
            is_live: false,
        }));

        return { parent_session, children };
    });
