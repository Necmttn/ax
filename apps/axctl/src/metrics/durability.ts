import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { fillDefaults, sessionIdsClause } from "./util.ts";

const DurabilityRow = Schema.Struct({
    session: Schema.String,
    produced: NumberFromBigIntColumn,
    reverted: NumberFromBigIntColumn,
});

export interface Durability {
    readonly produced: number;
    readonly reverted: number;
    readonly ratio: number | null; // null = no commits (distinct from 0)
}

export const computeDurability = (
    read: CacheReadService,
    sessionIds: readonly string[],
): Effect.Effect<Map<string, Durability>, CacheReadError> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return new Map();
        const sessions = sessionIdsClause("p.in_id", sessionIds);
        const result = yield* read.rows(DurabilityRow, `
SELECT p.in_id AS session,
       count(*) AS produced,
       count(*) FILTER (WHERE c.reverted = true) AS reverted
FROM produced p
JOIN "commit" c ON c.id = p.out_id
WHERE TRUE ${sessions.sql}
GROUP BY p.in_id`, sessions.params);
        const map = new Map<string, Durability>();
        for (const row of result) {
            const { produced, reverted } = row;
            map.set(row.session, { produced, reverted, ratio: produced === 0 ? null : (produced - reverted) / produced });
        }
        return fillDefaults(map, sessionIds, { produced: 0, reverted: 0, ratio: null });
    });
