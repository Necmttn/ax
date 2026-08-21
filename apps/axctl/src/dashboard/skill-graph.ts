import { Effect, Schema } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import type {
    SkillGraphEdge,
    SkillGraphNode,
    SkillGraphPayload,
} from "@ax/lib/shared/dashboard-types";

export interface SkillGraphParams {
    readonly minCount?: number;
    readonly limit?: number;
}

// The `GET /api/skill-graph` DuckDB query, consumed via `fetchSkillGraph` by
// `dashboard/contract/insights.ts`. `skill_paired.last_seen` is NOT NULL (the
// derive-signals writer always stamps a real Date, falling back to "now"
// rather than an epoch sentinel), so the column is selected directly with no
// null guard needed.
const SKILL_GRAPH_EDGES_SQL = `
    SELECT
        s_in.name AS source,
        s_out.name AS target,
        sp.count AS count,
        sp.last_seen AS last_seen
    FROM skill_paired sp
    JOIN skill s_in ON s_in.id = sp.in_id
    JOIN skill s_out ON s_out.id = sp.out_id
    WHERE sp.count >= ?
      AND sp.in_id <> sp.out_id
      AND s_in.name IS NOT NULL
      AND s_out.name IS NOT NULL
    ORDER BY sp.count DESC
    LIMIT ?
`;

const SkillGraphEdgeDbRow = Schema.Struct({
    source: Schema.String,
    target: Schema.String,
    count: NumberFromBigIntColumn,
    last_seen: TimestampColumn,
});

export const fetchSkillGraph = (
    params: SkillGraphParams = {},
): Effect.Effect<SkillGraphPayload, never, CacheRead> =>
    Effect.gen(function* () {
        // No hardcoded noise floor: default to 1 (no filtering) and let
        // `ORDER BY count DESC` + `limit` do the real work of surfacing the
        // strongest edges first. A fixed floor like the former 50 has no
        // relationship to the actual count distribution and can hide nearly
        // all of it - measured on this graph, 50 kept 4/34 edges while every
        // edge is already ordered strongest-first and capped by `limit`.
        // `minCount` stays as an opt-in refinement for a caller who wants to
        // prune the long tail themselves (#832).
        const minCount = Math.max(1, Math.floor(params.minCount ?? 1));
        const limit = Math.max(10, Math.min(2000, Math.floor(params.limit ?? 400)));

        const rows = yield* cacheRows(
            SkillGraphEdgeDbRow,
            { sql: SKILL_GRAPH_EDGES_SQL, params: [minCount, limit] },
            "skill-graph.edges",
        );

        const edges: SkillGraphEdge[] = rows
            .filter((row) => row.source !== row.target)
            .map((row) => ({
                source: row.source,
                target: row.target,
                count: row.count,
                last_seen: row.last_seen.toISOString(),
            }));

        // Degree-sum doubles as the node weight (how connected a skill is).
        const degree = new Map<string, number>();
        const lastSeen = new Map<string, string | null>();
        let maxEdge = 0;

        for (const edge of edges) {
            degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.count);
            degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.count);
            if (edge.last_seen) {
                const prev = lastSeen.get(edge.source) ?? null;
                if (!prev || edge.last_seen > prev) lastSeen.set(edge.source, edge.last_seen);
                const prev2 = lastSeen.get(edge.target) ?? null;
                if (!prev2 || edge.last_seen > prev2) lastSeen.set(edge.target, edge.last_seen);
            }
            if (edge.count > maxEdge) maxEdge = edge.count;
        }

        const nodes: SkillGraphNode[] = Array.from(degree.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([name, weight]) => ({
                name,
                weight,
                last_seen: lastSeen.get(name) ?? null,
            }));

        return {
            minCount,
            limit,
            node_count: nodes.length,
            edge_count: edges.length,
            max_edge_count: maxEdge,
            nodes,
            edges,
        };
    });
