import { Effect } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import type {
    SessionCanvasEdge,
    SessionCanvasNode,
    SessionCanvasPayload,
    SessionOrchestration,
} from "@ax/lib/shared/dashboard-types";

// Session lineage canvas. Nodes come from `session_health` (precomputed
// per-session metrics, always populated - same source the graph-explorer
// reads); edges come from the typed `spawned` relation (parent -> subagent).
// Both spawned endpoints are sessions, so the node set is self-contained.
//
// v0 sizing is turn volume - a stand-in for the real design target (context
// token volume + compaction epochs), which needs the Claude per-turn token +
// `compact_boundary` ingest that does not exist yet. `epochs` defaults to 1.

// Nodes come from `session` (authoritative - 500+ rows), NOT `session_health`
// (a derived subset that only covers ~a quarter of sessions). Reading from the
// subset orphaned every spawn parent/child that lacked a health row, dropping
// their edges. `session_health` is now a per-row LEFT decoration for the size +
// context-pressure signals only - same pattern as graph-explorer's FILE_ATTENTION_SQL.
// SQL below is DuckDB (CacheRead), translated from the original SurrealQL -
// see the per-query comments for the shape each still feeds into
// `rowsToSessionCanvas`/`rowsToOrchestration` (both pure, engine-agnostic
// `Record<string, unknown>` consumers, unchanged by this port).
export const SESSION_NODES_SQL = `
SELECT id, project, COALESCE(source, 'claude') AS source, started_at, ended_at
FROM session
ORDER BY started_at DESC
LIMIT ?;`;

// session_health decoration (label / pressure / corrections), batched as ONE
// scan + joined in TS - NOT 4 correlated subqueries per node (the issue-#77 trap
// that made the node query ~27s once session_health grew via the backfill).
export const SESSION_HEALTH_SQL = `
SELECT session AS s, task_label,
       COALESCE(context_pressure, 'unknown') AS context_pressure,
       COALESCE(correction_turns, 0) AS corrections,
       COALESCE(interruptions, 0) AS interruptions
FROM session_health;`;

// Spawn edges + child timing. `ts` = when the parent dispatched; child
// started_at/ended_at give the subagent's run span. Used both for lineage edges
// and to derive the parent's work/wait rail (blocked while a child runs).
// LEFT JOIN (not INNER): an edge whose child session row is missing/not-yet-
// ingested still renders (child_start/child_end simply come back null).
export const SPAWNED_EDGES_SQL = `
SELECT sp.in_id AS source, sp.out_id AS target, sp.nickname AS label,
       sp.ts AS spawn_ts, s.started_at AS child_start, s.ended_at AS child_end
FROM spawned sp LEFT JOIN session s ON s.id = sp.out_id;`;

// Conversational turn volume per session, counted directly from `turn` (works
// for ALL sessions, not just the ~quarter with a session_health row). One
// grouped aggregate scan - NOT a correlated per-session subquery (the issue-#77
// perf trap). Joined onto nodes by id in `rowsToSessionCanvas`.
//
// role IN ('user','assistant') only: Codex writes a `turn` row per fine-grained
// provider event (tool_call, function_call_output, reasoning, ...), so an
// unfiltered count inflates Codex sessions ~10x vs Claude and is not
// cross-provider comparable. Conversational turns approximate real rounds. This
// is still a v0 proxy - true size is context-token volume (pending token ingest).
export const TURN_COUNTS_SQL = `
SELECT session AS s, count(*) AS turns
FROM turn WHERE role IN ('user', 'assistant') GROUP BY session;`;

// Context-token volume per session = the real "how much context did this burn"
// size signal (cross-provider; session-health derives estimated_tokens for all
// sources). One indexed scan of session_token_usage (UNIQUE on session).
export const SESSION_TOKENS_SQL = `
SELECT session AS s, COALESCE(estimated_tokens, 0) AS tokens
FROM session_token_usage;`;

// Compaction boundaries per session (oldest-first via ts), for epoch notches.
// `tokens_before` = context size at the moment it compacted. The `compaction`
// table is owned/ingested by the compaction-signal feature (all providers);
// this is read-only consumption. Graceful when empty: nodes show epochs=1.
export const COMPACTIONS_SQL = `
SELECT session AS s, ts, COALESCE(tokens_before, 0) AS pre_tokens, COALESCE(trigger, 'auto') AS trigger
FROM compaction ORDER BY ts ASC;`;

const str = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s.length > 0 && s !== "[object Object]" ? s : null;
};

const num = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

const dateStr = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (value && typeof value === "object" && "toJSON" in value) {
        const json = (value as { toJSON: () => unknown }).toJSON();
        if (typeof json === "string" && json.length > 0) return json;
    }
    return null;
};

const toneFor = (corrections: number, interruptions: number): string =>
    corrections > 0 || interruptions > 0 ? "warning" : "success";

const ms = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
};

interface ChildInterval { startMs: number; endMs: number; }

/** Merge child run-intervals and express the time the main agent was blocked as
 *  fractions [0..1] of the parent's [start, end]. Overlapping children (parallel
 *  fan-out) collapse into one wait band. */
export function waitSegments(
    parentStart: string | null,
    parentEnd: string | null,
    children: ReadonlyArray<ChildInterval>,
): Array<{ start: number; end: number }> {
    const p0 = ms(parentStart);
    const p1 = ms(parentEnd);
    if (p0 === null || p1 === null || p1 <= p0 || children.length === 0) return [];
    const span = p1 - p0;
    const clipped = children
        .map((c) => ({ a: Math.max(p0, c.startMs), b: Math.min(p1, c.endMs) }))
        .filter((c) => c.b > c.a)
        .sort((x, y) => x.a - y.a);
    const merged: Array<{ a: number; b: number }> = [];
    for (const c of clipped) {
        const last = merged[merged.length - 1];
        if (last && c.a <= last.b) last.b = Math.max(last.b, c.b);
        else merged.push({ ...c });
    }
    return merged.map((m) => ({ start: (m.a - p0) / span, end: (m.b - p0) / span }));
}

export interface RowsToSessionCanvasInput {
    readonly nodeRows: ReadonlyArray<Record<string, unknown>>;
    readonly edgeRows: ReadonlyArray<Record<string, unknown>>;
    readonly turnRows: ReadonlyArray<Record<string, unknown>>;
    readonly tokenRows: ReadonlyArray<Record<string, unknown>>;
    readonly compactionRows: ReadonlyArray<Record<string, unknown>>;
    readonly healthRows: ReadonlyArray<Record<string, unknown>>;
    readonly generatedAt?: string;
    readonly warnings?: ReadonlyArray<string>;
}

interface HealthInfo { label: string | null; context_pressure: string; corrections: number; interruptions: number; }

export function rowsToSessionCanvas(input: RowsToSessionCanvasInput): SessionCanvasPayload {
    const nodeById = new Map<string, SessionCanvasNode>();
    const subagentIds = new Set<string>();

    const turnsById = new Map<string, number>();
    for (const row of input.turnRows) {
        const id = str(row, "s");
        if (id) turnsById.set(id, num(row, "turns"));
    }

    const tokensById = new Map<string, number>();
    for (const row of input.tokenRows) {
        const id = str(row, "s");
        if (id) tokensById.set(id, num(row, "tokens"));
    }

    const healthById = new Map<string, HealthInfo>();
    for (const row of input.healthRows) {
        const id = str(row, "s");
        if (id) healthById.set(id, {
            label: str(row, "task_label"),
            context_pressure: str(row, "context_pressure") ?? "unknown",
            corrections: num(row, "corrections"),
            interruptions: num(row, "interruptions"),
        });
    }

    // compaction boundaries per session, oldest-first, for epoch notches.
    // Dedupe by ts: the source can carry duplicate boundary rows (re-ingest /
    // backfill), which would otherwise inflate the epoch count.
    const compactionsById = new Map<string, Array<{ pre_tokens: number; trigger: string }>>();
    const seenTsById = new Map<string, Set<string>>();
    for (const row of input.compactionRows) {
        const id = str(row, "s");
        if (!id) continue;
        const ts = str(row, "ts") ?? "";
        const seen = seenTsById.get(id) ?? new Set<string>();
        if (ts && seen.has(ts)) continue;
        seen.add(ts);
        seenTsById.set(id, seen);
        const list = compactionsById.get(id) ?? [];
        list.push({ pre_tokens: num(row, "pre_tokens"), trigger: str(row, "trigger") ?? "auto" });
        compactionsById.set(id, list);
    }

    const edges: SessionCanvasEdge[] = [];
    const childIntervalsByParent = new Map<string, ChildInterval[]>();
    const childCountByParent = new Map<string, number>();
    for (const row of input.edgeRows) {
        const source = str(row, "source");
        const target = str(row, "target");
        if (!source || !target || source === target) continue;
        subagentIds.add(target);
        edges.push({ source, target, relation: "spawned", label: str(row, "label") });
        childCountByParent.set(source, (childCountByParent.get(source) ?? 0) + 1);
        // child run interval (start = spawn_ts or child_start; end = child_end)
        const startMs = ms(dateStr(row, "child_start")) ?? ms(dateStr(row, "spawn_ts"));
        const endMs = ms(dateStr(row, "child_end"));
        if (startMs !== null && endMs !== null) {
            const list = childIntervalsByParent.get(source) ?? [];
            list.push({ startMs, endMs });
            childIntervalsByParent.set(source, list);
        }
    }

    for (const row of input.nodeRows) {
        const id = str(row, "id");
        if (!id || nodeById.has(id)) continue;
        const health = healthById.get(id);
        const corrections = health?.corrections ?? 0;
        const interruptions = health?.interruptions ?? 0;
        const project = str(row, "project");
        const compactions = compactionsById.get(id) ?? [];
        const startedAt = dateStr(row, "started_at");
        const endedAt = dateStr(row, "ended_at");
        nodeById.set(id, {
            id,
            label: health?.label ?? project ?? id,
            project,
            source: str(row, "source") ?? "claude",
            started_at: startedAt,
            ended_at: endedAt,
            size: Math.max(1, tokensById.get(id) ?? 0),
            turns: turnsById.get(id) ?? 0,
            epochs: compactions.length + 1,
            compactions,
            context_pressure: health?.context_pressure ?? "unknown",
            corrections,
            tone: toneFor(corrections, interruptions),
            is_subagent: false,
            subagent_count: childCountByParent.get(id) ?? 0,
            wait_segments: waitSegments(startedAt, endedAt, childIntervalsByParent.get(id) ?? []),
        });
    }

    // A spawned edge can reference a subagent session that has no
    // session_health row yet; synthesize a minimal node so the edge renders.
    for (const id of subagentIds) {
        const existing = nodeById.get(id);
        if (existing) {
            nodeById.set(id, { ...existing, is_subagent: true });
        } else {
            const compactions = compactionsById.get(id) ?? [];
            const health = healthById.get(id);
            nodeById.set(id, {
                id,
                label: health?.label ?? id,
                project: null,
                source: "claude",
                started_at: null,
                ended_at: null,
                size: Math.max(1, tokensById.get(id) ?? 0),
                turns: turnsById.get(id) ?? 0,
                epochs: compactions.length + 1,
                compactions,
                context_pressure: health?.context_pressure ?? "unknown",
                corrections: health?.corrections ?? 0,
                tone: "neutral",
                is_subagent: true,
                subagent_count: childCountByParent.get(id) ?? 0,
                wait_segments: [],
            });
        }
    }

    const nodes = Array.from(nodeById.values()).sort((a, b) => b.size - a.size);
    // Drop edges whose endpoints fell outside the node window (LIMIT).
    const present = new Set(nodes.map((n) => n.id));
    const liveEdges = edges.filter((e) => present.has(e.source) && present.has(e.target));

    return {
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        nodes,
        edges: liveEdges,
        warnings: input.warnings ?? [],
    };
}

const clampLimit = (limit: number | undefined): number => {
    const value = Math.floor(limit ?? 800);
    if (!Number.isFinite(value)) return 800;
    return Math.max(10, Math.min(2000, value));
};

// ---- Orchestration drill-in: one session's subagent timeline ----

export const ORCH_PARENT_SQL = `
SELECT
    id,
    COALESCE(
        (SELECT task_label FROM session_health WHERE session = s.id LIMIT 1),
        s.project, s.id
    ) AS label,
    started_at, ended_at
FROM session s WHERE s.id = ? LIMIT 1;`;

export const ORCH_CHILDREN_SQL = `
SELECT sp.out_id AS id, sp.nickname AS nickname, sp.ts AS ts,
       s.started_at AS started_at, s.ended_at AS ended_at
FROM spawned sp LEFT JOIN session s ON s.id = sp.out_id
WHERE sp.in_id = ? ORDER BY sp.ts ASC;`;

// First user turn per child session = the subagent's dispatch task. Per-child
// bound-parameter `session = ?` LIMIT 1 (hits the session index) instead of
// `turn WHERE session IN (<all children>)`, which is a membership scan over the
// 560k-row turn table (~1.3s for 117 children) - the same trap fixed in
// enrichSessions. Plain equality now (DuckDB ids are bound params, not spliced
// record-ref literals - the old "exact record-ref literal" indexing workaround
// no longer applies).
const ORCH_TASK_SQL = `
SELECT session AS s, text_excerpt, seq
FROM turn WHERE session = ? AND role = 'user' ORDER BY seq ASC LIMIT 1;`;

/** Per-child fan-out width for the dispatch-task reads. */
const ORCH_TASK_FANOUT = 16;

const QUICK_SUBAGENT_MS = 60_000;

export function rowsToOrchestration(
    parentRow: Record<string, unknown> | undefined,
    childRows: ReadonlyArray<Record<string, unknown>>,
    sessionId: string,
    tasksById: ReadonlyMap<string, string> = new Map(),
): SessionOrchestration {
    const startedAt = parentRow ? dateStr(parentRow, "started_at") : null;
    const endedAt = parentRow ? dateStr(parentRow, "ended_at") : null;
    const intervals: ChildInterval[] = [];
    const subagents = childRows.map((row) => {
        const cs = dateStr(row, "started_at");
        const ce = dateStr(row, "ended_at");
        const sMs = ms(cs);
        const eMs = ms(ce);
        const duration = sMs !== null && eMs !== null && eMs >= sMs ? eMs - sMs : null;
        if (sMs !== null && eMs !== null) intervals.push({ startMs: sMs, endMs: eMs });
        const childId = str(row, "id") ?? "";
        const taskRaw = tasksById.get(childId) ?? null;
        return {
            id: childId,
            nickname: str(row, "nickname"),
            task: taskRaw ? taskRaw.replace(/\s+/g, " ").slice(0, 120) : null,
            started_at: cs,
            ended_at: ce,
            duration_ms: duration,
            tone: duration === null ? "unknown" : duration < QUICK_SUBAGENT_MS ? "quick" : "long",
        };
    });
    // wait_pct = total merged wait span / parent span
    const segs = waitSegments(startedAt, endedAt, intervals);
    const waitPct = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
    return {
        session_id: sessionId,
        label: parentRow ? (str(parentRow, "label") ?? sessionId) : sessionId,
        started_at: startedAt,
        ended_at: endedAt,
        wait_pct: Math.min(1, Math.max(0, waitPct)),
        subagents,
    };
}

/** Undecoded raw() reads throughout this module: row shapes vary per query
 *  and are already consumed by lenient, engine-agnostic `Record<string,
 *  unknown>` helpers (`str`/`num`/`dateStr` above) shared with the JSONL/
 *  Surreal-era pure functions - a typed Schema per query would just be
 *  re-derived busywork these helpers already do defensively. Defensive: a
 *  failed query degrades to `[]`, per-query (not batch-wide), matching the
 *  `cacheRows` contract used throughout the rest of this port. */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, never> =>
    read.raw(sql, params).pipe(
        Effect.map((r) => r.rows as ReadonlyArray<Record<string, unknown>>),
        Effect.catch((err) =>
            Effect.sync(() => {
                console.error(`ax session-canvas query failed (${sql.trim().slice(0, 60)}...):`, err);
                return [] as ReadonlyArray<Record<string, unknown>>;
            }),
        ),
    );

export const fetchSessionOrchestration = (
    sessionId: string,
): Effect.Effect<SessionOrchestration, never, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const [parentRows, childRows] = yield* Effect.all([
            rawRows(read, ORCH_PARENT_SQL, [sessionId]),
            rawRows(read, ORCH_CHILDREN_SQL, [sessionId]),
        ]);
        // Per-child task fetch, fanned out instead of a single
        // `session IN (<all children>)` membership scan over the turn table.
        const childIds = childRows.map((r) => str(r, "id")).filter((s): s is string => !!s);
        const tasksById = new Map<string, string>();
        if (childIds.length > 0) {
            const perChild = yield* Effect.forEach(
                childIds,
                (id) => rawRows(read, ORCH_TASK_SQL, [id]).pipe(Effect.map((rows) => rows[0])),
                { concurrency: ORCH_TASK_FANOUT },
            );
            for (const r of perChild) {
                if (!r) continue;
                const s = str(r, "s");
                const ex = str(r, "text_excerpt");
                if (s && ex && !tasksById.has(s)) tasksById.set(s, ex); // first (lowest seq) wins
            }
        }
        return rowsToOrchestration(parentRows[0], childRows, sessionId, tasksById);
    });

export interface SessionCanvasParams {
    readonly limit?: number;
}

export const fetchSessionCanvas = (
    params: SessionCanvasParams = {},
): Effect.Effect<SessionCanvasPayload, never, CacheRead> =>
    Effect.gen(function* () {
        const limit = clampLimit(params.limit);
        const read = yield* CacheRead;
        const [nodeRows, edgeRows, turnRows, tokenRows, compactionRows, healthRows] = yield* Effect.all([
            rawRows(read, SESSION_NODES_SQL, [limit]),
            rawRows(read, SPAWNED_EDGES_SQL),
            rawRows(read, TURN_COUNTS_SQL),
            rawRows(read, SESSION_TOKENS_SQL),
            rawRows(read, COMPACTIONS_SQL),
            rawRows(read, SESSION_HEALTH_SQL),
        ]);
        return rowsToSessionCanvas({ nodeRows, edgeRows, turnRows, tokenRows, compactionRows, healthRows });
    });
