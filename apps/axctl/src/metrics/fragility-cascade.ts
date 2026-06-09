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
