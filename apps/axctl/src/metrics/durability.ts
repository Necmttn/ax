import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";

export interface Durability {
    readonly produced: number;
    readonly reverted: number;
    readonly ratio: number | null; // null = no commits (distinct from 0)
}

const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

export const computeDurability = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, Durability>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (sessionIds.length === 0) return new Map();
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        const result = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(in) AS session,
       count() AS produced,
       count(out.reverted = true) AS reverted
FROM produced
WHERE in IN [${refs}]
GROUP BY session;`))?.[0] ?? [];
        const map = new Map<string, Durability>();
        for (const row of result) {
            const produced = Number(row.produced ?? 0);
            const reverted = Number(row.reverted ?? 0);
            map.set(String(row.session), { produced, reverted, ratio: produced === 0 ? null : (produced - reverted) / produced });
        }
        for (const id of sessionIds) if (!map.has(id)) map.set(id, { produced: 0, reverted: 0, ratio: null });
        return map;
    });
