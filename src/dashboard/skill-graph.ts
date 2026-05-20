import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { skillGraphEdgesQuery } from "../queries/skill-graph.ts";
import type {
    SkillGraphEdge,
    SkillGraphNode,
    SkillGraphPayload,
} from "../lib/shared/dashboard-types.ts";
import { runQuery } from "../lib/shared/graph-query.ts";

export interface SkillGraphParams {
    readonly minCount?: number;
    readonly limit?: number;
}

export const fetchSkillGraph = (
    params: SkillGraphParams = {},
): Effect.Effect<SkillGraphPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const minCount = Math.max(1, Math.floor(params.minCount ?? 50));
        const limit = Math.max(10, Math.min(2000, Math.floor(params.limit ?? 400)));

        const mapped = yield* runQuery(skillGraphEdgesQuery, { minCount, limit });

        const edges: SkillGraphEdge[] = mapped.filter(
            (e): e is SkillGraphEdge => e !== null,
        );

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
            min_count: minCount,
            limit,
            node_count: nodes.length,
            edge_count: edges.length,
            max_edge_count: maxEdge,
            nodes,
            edges,
        };
    });
