import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface CascadeEdge {
    readonly origin: string;
    readonly downstream: string;
    readonly weight: number; // distinct downstream fixers for this origin
}

/**
 * Cross-session fragility cascade. A reverted commit's session (origin) touched
 * a file; later, OTHER sessions edited the same file (downstream fixers).
 * Edge origin→downstream; weight = distinct downstream sessions per origin.
 * Reuses the Task-2 `commit.reverted` primitive (no later_fixed_by re-walk).
 */
export const computeFragilityCascade = (): Effect.Effect<CascadeEdge[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // WAVE-2: this single-query form is NOT yet live-correct and is not wired
        // to any surface. The `FROM (subquery) AS o, (subquery) AS d` comma-join +
        // table aliases are rejected by SurrealDB 3.1 (same parse error that hit
        // time-to-land), and an `in.session` deref over all `edited` edges risks
        // the 87k-edge per-deref hang. Before surfacing, replace with a 3-query
        // JS join: (1) touched WHERE in.reverted=true, (2) produced commit→session,
        // (3) edited file/session/ts - joined + weighted in JS (the dedup/weight
        // logic below is already tested and stays). Until then this query is
        // exercised only by the mocked unit test.
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(origin) AS origin,
  type::string(downstream) AS downstream,
  type::string(file) AS file
FROM (
  SELECT (<-produced<-session)[0] AS origin, out AS file, ts AS origin_ts
  FROM touched WHERE in.reverted = true
) AS o,
(
  SELECT in.session AS downstream, out AS file, ts FROM edited
) AS d
WHERE o.file = d.file AND d.downstream != o.origin AND d.ts > o.origin_ts;`))?.[0] ?? [];

        const pairs = new Set<string>();
        const downstreamByOrigin = new Map<string, Set<string>>();
        for (const r of rows) {
            const origin = String(r.origin);
            const downstream = String(r.downstream);
            if (!origin || !downstream || origin === "null" || downstream === "null") continue;
            pairs.add(`${origin} ${downstream}`);
            let set = downstreamByOrigin.get(origin);
            if (!set) {
                set = new Set();
                downstreamByOrigin.set(origin, set);
            }
            set.add(downstream);
        }
        return [...pairs].map((p) => {
            const [origin, downstream] = p.split(" ");
            return { origin, downstream, weight: downstreamByOrigin.get(origin)!.size };
        });
    });
