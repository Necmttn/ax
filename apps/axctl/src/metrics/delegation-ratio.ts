import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";

/**
 * Share of a session's total landed commits that came from its `spawned`
 * subagent sessions: sub / (direct + sub). null when the total produced is 0
 * (distinct from 0 = produced commits but none delegated).
 *
 * `spawned` is `FROM session TO session` (in = parent, out = child). Three flat
 * set-based reads joined in JS: direct produced per session, the parent→child
 * spawn edges, and the children's produced counts. Each read is bounded by an
 * IN-list (`produced.in`/`spawned.in` are indexed), so no per-edge deref.
 */
export const computeDelegationRatio = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const refs = sessionIds.map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? "")).join(", ");

        // A. Direct produced count per session.
        const directRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(in) AS session, count() AS direct FROM produced WHERE in IN [${refs}] GROUP BY session;`,
        ))?.[0] ?? [];
        const direct = new Map<string, number>();
        for (const r of directRows) direct.set(String(r.session), Number(r.direct ?? 0));

        // B. Spawn children: parent → [child].
        const spawnRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(in) AS parent, type::string(out) AS child FROM spawned WHERE in IN [${refs}];`,
        ))?.[0] ?? [];
        const childrenByParent = new Map<string, string[]>();
        const childIds = new Set<string>();
        for (const r of spawnRows) {
            const parent = String(r.parent);
            const child = String(r.child);
            const list = childrenByParent.get(parent) ?? [];
            list.push(child);
            childrenByParent.set(parent, list);
            childIds.add(child);
        }

        // C. Children's produced counts (skip when there are no children).
        const producedByChild = new Map<string, number>();
        if (childIds.size > 0) {
            const childRefs = [...childIds]
                .map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? ""))
                .join(", ");
            const childRows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT type::string(in) AS session, count() AS produced FROM produced WHERE in IN [${childRefs}] GROUP BY session;`,
            ))?.[0] ?? [];
            for (const r of childRows) producedByChild.set(String(r.session), Number(r.produced ?? 0));
        }

        for (const id of sessionIds) {
            const directCount = direct.get(id) ?? 0;
            const children = childrenByParent.get(id) ?? [];
            const sub = children.reduce((acc, child) => acc + (producedByChild.get(child) ?? 0), 0);
            const total = directCount + sub;
            map.set(id, total === 0 ? null : sub / total);
        }
        return map;
    });
