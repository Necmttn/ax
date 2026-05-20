/**
 * Skill pair graph: surface `skill_paired` edges as a node/edge graph that
 * the dashboard can render.
 *
 * The `skill_paired` relation is undirected - `derive-signals` writes each
 * co-occurrence once with the lexicographically-smaller skill on `in`. We
 * project both endpoints' names so the SPA can render nodes without a
 * second round-trip.
 *
 * Bindings:
 *  - $minCount (int) - drop pairs below this co-occurrence count. The default
 *    50 still surfaces hundreds of edges on a year-old graph; the UI bumps
 *    it higher if the result is too dense.
 *  - $limit (int) - hard ceiling on edges returned (keeps SVG render bounded).
 */
import { defineQuery } from "./query.ts";
import { isRecord, stringField, dateField, numberField } from "../lib/shared/row-fields.ts";
import type { SkillGraphEdge } from "../lib/shared/dashboard-types.ts";

export const SKILL_GRAPH_EDGES_SQL = `
SELECT
    in.name AS source,
    out.name AS target,
    count,
    (IF last_seen > d"1970-01-02" THEN last_seen ELSE NONE END) AS last_seen
FROM skill_paired
WHERE count >= $minCount
  AND in.name IS NOT NONE
  AND out.name IS NOT NONE
ORDER BY count DESC
LIMIT $limit;`;

// ---------------------------------------------------------------------------
// Typed Query seam
// ---------------------------------------------------------------------------

export interface SkillGraphEdgesParams {
    readonly minCount: number;
    readonly limit: number;
}

export const skillGraphEdgesQuery = defineQuery<
    SkillGraphEdgesParams,
    Record<string, unknown>,
    SkillGraphEdge | null
>({
    name: "skill-graph.edges",
    sql: () => SKILL_GRAPH_EDGES_SQL,
    bindings: (p) => ({ minCount: p.minCount, limit: p.limit }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const source = stringField(raw, "source");
        const target = stringField(raw, "target");
        if (!source || !target || source === target) return null;
        const count = numberField(raw, "count") ?? 0;
        return {
            source,
            target,
            count,
            last_seen: dateField(raw, "last_seen"),
        };
    },
});
