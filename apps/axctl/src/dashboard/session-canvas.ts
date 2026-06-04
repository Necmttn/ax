import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type {
    SessionCanvasEdge,
    SessionCanvasNode,
    SessionCanvasPayload,
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
SELECT
    <string>id AS id,
    (
        (SELECT task_label FROM session_health WHERE session = $parent.id LIMIT 1)[0].task_label
        ?? project
        ?? <string>id
    ) AS label,
    (project ?? NONE) AS project,
    (source ?? "claude") AS source,
    started_at,
    ended_at,
    ((SELECT context_pressure FROM session_health WHERE session = $parent.id LIMIT 1)[0].context_pressure ?? "unknown") AS context_pressure,
    ((SELECT correction_turns FROM session_health WHERE session = $parent.id LIMIT 1)[0].correction_turns ?? 0) AS corrections,
    ((SELECT interruptions FROM session_health WHERE session = $parent.id LIMIT 1)[0].interruptions ?? 0) AS interruptions
FROM session
ORDER BY started_at DESC
LIMIT $limit;`;

export const SPAWNED_EDGES_SQL = `
SELECT <string>in AS source, <string>out AS target, (nickname ?? NONE) AS label
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

export interface RowsToSessionCanvasInput {
    readonly nodeRows: ReadonlyArray<Record<string, unknown>>;
    readonly edgeRows: ReadonlyArray<Record<string, unknown>>;
    readonly turnRows: ReadonlyArray<Record<string, unknown>>;
    readonly generatedAt?: string;
    readonly warnings?: ReadonlyArray<string>;
}

export function rowsToSessionCanvas(input: RowsToSessionCanvasInput): SessionCanvasPayload {
    const nodeById = new Map<string, SessionCanvasNode>();
    const subagentIds = new Set<string>();

    const turnsById = new Map<string, number>();
    for (const row of input.turnRows) {
        const id = str(row, "s");
        if (id) turnsById.set(id, num(row, "turns"));
    }

    const edges: SessionCanvasEdge[] = [];
    for (const row of input.edgeRows) {
        const source = str(row, "source");
        const target = str(row, "target");
        if (!source || !target || source === target) continue;
        subagentIds.add(target);
        edges.push({
            source,
            target,
            relation: "spawned",
            label: str(row, "label"),
        });
    }

    for (const row of input.nodeRows) {
        const id = str(row, "id");
        if (!id || nodeById.has(id)) continue;
        const corrections = num(row, "corrections");
        const interruptions = num(row, "interruptions");
        nodeById.set(id, {
            id,
            label: str(row, "label") ?? id,
            project: str(row, "project"),
            source: str(row, "source") ?? "claude",
            started_at: dateStr(row, "started_at"),
            ended_at: dateStr(row, "ended_at"),
            size: Math.max(1, turnsById.get(id) ?? 0),
            epochs: 1,
            context_pressure: str(row, "context_pressure") ?? "unknown",
            corrections,
            tone: toneFor(corrections, interruptions),
            is_subagent: false,
        });
    }

    // A spawned edge can reference a subagent session that has no
    // session_health row yet; synthesize a minimal node so the edge renders.
    for (const id of subagentIds) {
        const existing = nodeById.get(id);
        if (existing) {
            nodeById.set(id, { ...existing, is_subagent: true });
        } else {
            nodeById.set(id, {
                id,
                label: id,
                project: null,
                source: "claude",
                started_at: null,
                ended_at: null,
                size: Math.max(1, turnsById.get(id) ?? 0),
                epochs: 1,
                context_pressure: "unknown",
                corrections: 0,
                tone: "neutral",
                is_subagent: true,
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
        return rowsToSessionCanvas({
            nodeRows: nodeRows?.[0] ?? [],
            edgeRows: edgeRows?.[0] ?? [],
            turnRows: turnRows?.[0] ?? [],
            warnings: [
                "v0: node size is turn count; context-token + compaction-epoch sizing pending ingest.",
            ],
        });
    });
