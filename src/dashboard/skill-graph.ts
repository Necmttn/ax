import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { SKILL_GRAPH_EDGES_SQL } from "../queries/skill-graph.ts";
import type {
    SkillGraphEdge,
    SkillGraphNode,
    SkillGraphPayload,
} from "../lib/shared/dashboard-types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const numField = (row: Record<string, unknown>, key: string): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

export interface SkillGraphParams {
    readonly minCount?: number;
    readonly limit?: number;
}

export const fetchSkillGraph = (
    params: SkillGraphParams = {},
): Effect.Effect<SkillGraphPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const minCount = Math.max(1, Math.floor(params.minCount ?? 50));
        const limit = Math.max(10, Math.min(2000, Math.floor(params.limit ?? 400)));

        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            SKILL_GRAPH_EDGES_SQL,
            { minCount, limit },
        );

        const edges: SkillGraphEdge[] = [];
        // Degree-sum doubles as the node weight (how connected a skill is).
        const degree = new Map<string, number>();
        const lastSeen = new Map<string, string | null>();
        let maxEdge = 0;

        for (const raw of rows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const source = stringField(raw, "source");
            const target = stringField(raw, "target");
            if (!source || !target || source === target) continue;
            const count = numField(raw, "count");
            const seen = dateField(raw, "last_seen");
            edges.push({ source, target, count, last_seen: seen });
            degree.set(source, (degree.get(source) ?? 0) + count);
            degree.set(target, (degree.get(target) ?? 0) + count);
            if (seen) {
                const prev = lastSeen.get(source) ?? null;
                if (!prev || seen > prev) lastSeen.set(source, seen);
                const prev2 = lastSeen.get(target) ?? null;
                if (!prev2 || seen > prev2) lastSeen.set(target, seen);
            }
            if (count > maxEdge) maxEdge = count;
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
