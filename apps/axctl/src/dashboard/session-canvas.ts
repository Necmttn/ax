import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
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
export const SESSION_NODES_SQL = `
SELECT <string>id AS id, (project ?? NONE) AS project, (source ?? "claude") AS source, started_at, ended_at
FROM session
ORDER BY started_at DESC
LIMIT $limit;`;

// session_health decoration (label / pressure / corrections), batched as ONE
// scan + joined in TS - NOT 4 correlated subqueries per node (the issue-#77 trap
// that made the node query ~27s once session_health grew via the backfill).
export const SESSION_HEALTH_SQL = `
SELECT <string>session AS s, task_label,
       (context_pressure ?? "unknown") AS context_pressure,
       (correction_turns ?? 0) AS corrections,
       (interruptions ?? 0) AS interruptions
FROM session_health;`;

// Spawn edges + child timing. `ts` = when the parent dispatched; child
// started_at/ended_at give the subagent's run span. Used both for lineage edges
// and to derive the parent's work/wait rail (blocked while a child runs).
export const SPAWNED_EDGES_SQL = `
SELECT <string>in AS source, <string>out AS target, (nickname ?? NONE) AS label,
       ts AS spawn_ts, out.started_at AS child_start, out.ended_at AS child_end
FROM spawned;`;

// Conversational turn volume per session, counted directly from `turn` (works
// for ALL sessions, not just the ~quarter with a session_health row). One
// grouped aggregate scan - NOT a correlated per-session subquery (the issue-#77
// perf trap). Joined onto nodes by id in `rowsToSessionCanvas`.
//
// role IN ['user','assistant'] only: Codex writes a `turn` row per fine-grained
// provider event (tool_call, function_call_output, reasoning, ...), so an
// unfiltered count inflates Codex sessions ~10x vs Claude and is not
// cross-provider comparable. Conversational turns approximate real rounds. This
// is still a v0 proxy - true size is context-token volume (pending token ingest).
export const TURN_COUNTS_SQL = `
SELECT <string>session AS s, count() AS turns
FROM turn WHERE role IN ['user', 'assistant'] GROUP BY s;`;

// Context-token volume per session = the real "how much context did this burn"
// size signal (cross-provider; session-health derives estimated_tokens for all
// sources). One indexed scan of session_token_usage (UNIQUE on session).
export const SESSION_TOKENS_SQL = `
SELECT <string>session AS s, (estimated_tokens ?? 0) AS tokens
FROM session_token_usage;`;

// Compaction boundaries per session (oldest-first via ts), for epoch notches.
// `tokens_before` = context size at the moment it compacted. The `compaction`
// table is owned/ingested by the compaction-signal feature (all providers);
// this is read-only consumption. Graceful when empty: nodes show epochs=1.
export const COMPACTIONS_SQL = `
SELECT <string>session AS s, ts, (tokens_before ?? 0) AS pre_tokens, (trigger ?? "auto") AS trigger
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
    <string>id AS id,
    (
        (SELECT task_label FROM session_health WHERE session = $parent.id LIMIT 1)[0].task_label
        ?? project ?? <string>id
    ) AS label,
    started_at, ended_at
FROM session WHERE <string>id = $id LIMIT 1;`;

export const ORCH_CHILDREN_SQL = `
SELECT <string>out AS id, (nickname ?? NONE) AS nickname, ts,
       out.started_at AS started_at, out.ended_at AS ended_at
FROM spawned WHERE <string>in = $id ORDER BY ts ASC;`;

// First user turn per child session = the subagent's dispatch task. Per-child
// INDEXED `session = <ref>` LIMIT 1 (hits turn_session_seq) instead of
// `turn WHERE session IN [<all children>]`, which is a membership scan over the
// 560k-row turn table (~1.3s for 117 children) - the same trap fixed in
// enrichSessions. `childRef` is the exact `session:⟨uuid⟩` record-ref literal.
const orchTaskSql = (childRef: string): string => `
SELECT <string>session AS s, text_excerpt, seq
FROM turn WHERE session = ${childRef} AND role = "user" ORDER BY seq ASC LIMIT 1;`;

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

export const fetchSessionOrchestration = (
    sessionId: string,
): Effect.Effect<SessionOrchestration, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const parent = yield* db.query<[Array<Record<string, unknown>>]>(ORCH_PARENT_SQL, { id: sessionId });
        const children = yield* db.query<[Array<Record<string, unknown>>]>(ORCH_CHILDREN_SQL, { id: sessionId });
        const childRows = children?.[0] ?? [];
        // Per-child INDEXED task fetch (the `id` field is the exact
        // `session:⟨uuid⟩` record-ref literal). Fanned out instead of a single
        // `session IN [<all children>]` membership scan over the turn table.
        const childRefs = childRows.map((r) => str(r, "id")).filter((s): s is string => !!s);
        const tasksById = new Map<string, string>();
        if (childRefs.length > 0) {
            const perChild = yield* Effect.forEach(
                childRefs,
                (ref) =>
                    db.query<[Array<Record<string, unknown>>]>(orchTaskSql(ref), {})
                        .pipe(Effect.map(([rows]) => rows?.[0])),
                { concurrency: ORCH_TASK_FANOUT },
            );
            for (const r of perChild) {
                if (!r) continue;
                const s = str(r, "s");
                const ex = str(r, "text_excerpt");
                if (s && ex && !tasksById.has(s)) tasksById.set(s, ex); // first (lowest seq) wins
            }
        }
        return rowsToOrchestration(parent?.[0]?.[0], childRows, sessionId, tasksById);
    });

export interface SessionCanvasParams {
    readonly limit?: number;
}

export const fetchSessionCanvas = (
    params: SessionCanvasParams = {},
): Effect.Effect<SessionCanvasPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const limit = clampLimit(params.limit);
        const db = yield* SurrealClient;
        const nodeRows = yield* db.query<[Array<Record<string, unknown>>]>(
            SESSION_NODES_SQL,
            { limit },
        );
        const edgeRows = yield* db.query<[Array<Record<string, unknown>>]>(
            SPAWNED_EDGES_SQL,
            {},
        );
        const turnRows = yield* db.query<[Array<Record<string, unknown>>]>(
            TURN_COUNTS_SQL,
            {},
        );
        const tokenRows = yield* db.query<[Array<Record<string, unknown>>]>(
            SESSION_TOKENS_SQL,
            {},
        );
        const compactionRows = yield* db.query<[Array<Record<string, unknown>>]>(
            COMPACTIONS_SQL,
            {},
        );
        const healthRows = yield* db.query<[Array<Record<string, unknown>>]>(
            SESSION_HEALTH_SQL,
            {},
        );
        return rowsToSessionCanvas({
            nodeRows: nodeRows?.[0] ?? [],
            edgeRows: edgeRows?.[0] ?? [],
            turnRows: turnRows?.[0] ?? [],
            tokenRows: tokenRows?.[0] ?? [],
            compactionRows: compactionRows?.[0] ?? [],
            healthRows: healthRows?.[0] ?? [],
        });
    });
