import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";

const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

/**
 * Latency from a session's end to when its work landed: earliest `merged_at`
 * over PRs whose merge_sha resolves to a commit the session `produced`, minus
 * session.ended_at, in ms. null when nothing merged.
 */
export const computeTimeToLand = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        const result = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(in) AS session,
  math::min(
    (SELECT VALUE duration::millis(pr.merged_at - in.ended_at)
     FROM pull_request AS pr
     WHERE pr.merged_at != NONE
       AND pr.merge_sha = out.sha
       AND in.ended_at != NONE)
  ) AS ms
FROM produced
WHERE in IN [${refs}]
GROUP BY session;`))?.[0] ?? [];
        for (const row of result) {
            const ms = row.ms;
            map.set(String(row.session), typeof ms === "number" && Number.isFinite(ms) ? ms : null);
        }
        for (const id of sessionIds) if (!map.has(id)) map.set(id, null);
        return map;
    });
