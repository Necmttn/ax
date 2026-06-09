import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { fillDefaults, sessionRefList } from "./util.ts";

/**
 * Share of a session's total landed commits that came from its `spawned`
 * subtree: sub / (direct + sub). null when the total produced is 0 (distinct
 * from 0 = produced commits but none delegated).
 *
 * `spawned` is `FROM session TO session` (in = parent, out = child). `sub` is
 * the produced commits over the WHOLE descendant subtree (children,
 * grandchildren, …), not just direct children. The descendant set is built by
 * iteratively expanding the spawn frontier, bounded (depth cap 8) and
 * cycle-guarded with a global visited set so cyclic/self spawn edges can't loop
 * forever. Reads are bounded by an IN-list (`produced.in`/`spawned.in` are
 * indexed), so no per-edge deref.
 */
export const computeDelegationRatio = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;

        const refs = sessionRefList(sessionIds);

        // A. Direct produced count per root session.
        const directRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(in) AS session, count() AS direct FROM produced WHERE in IN [${refs}] GROUP BY session;`,
        ))?.[0] ?? [];
        const direct = new Map<string, number>();
        for (const r of directRows) direct.set(String(r.session), Number(r.direct ?? 0));

        // B. Full descendant closure per root: iteratively expand the spawn
        //    frontier. `descendantsByRoot` maps a root to its whole subtree
        //    (grandchildren+); `visited` is the global set of every session ever
        //    discovered as a descendant (cycle guard). Depth cap 8 bounds the walk.
        const descendantsByRoot = new Map<string, Set<string>>();
        for (const id of sessionIds) descendantsByRoot.set(id, new Set());
        // Track the current frontier per root so we expand the right subtree.
        let frontierByRoot = new Map<string, Set<string>>();
        for (const id of sessionIds) frontierByRoot.set(id, new Set([id]));
        const allDescendants = new Set<string>();

        for (let depth = 0; depth < 8; depth++) {
            // Union of all current frontier nodes across roots → one bounded read.
            const frontierNodes = new Set<string>();
            for (const set of frontierByRoot.values()) for (const n of set) frontierNodes.add(n);
            if (frontierNodes.size === 0) break;

            const frontierRefs = sessionRefList([...frontierNodes]);
            const spawnRows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT type::string(in) AS parent, type::string(out) AS child FROM spawned WHERE in IN [${frontierRefs}];`,
            ))?.[0] ?? [];
            const childrenByNode = new Map<string, string[]>();
            for (const r of spawnRows) {
                const parent = String(r.parent);
                const child = String(r.child);
                const list = childrenByNode.get(parent) ?? [];
                list.push(child);
                childrenByNode.set(parent, list);
            }

            const nextFrontierByRoot = new Map<string, Set<string>>();
            let anyNext = false;
            for (const [root, frontier] of frontierByRoot) {
                const descendants = descendantsByRoot.get(root)!;
                const next = new Set<string>();
                for (const node of frontier) {
                    for (const child of childrenByNode.get(node) ?? []) {
                        // Cycle guard: skip the root itself and anything already
                        // counted as a descendant of THIS root.
                        if (child === root || descendants.has(child)) continue;
                        descendants.add(child);
                        allDescendants.add(child);
                        next.add(child);
                        anyNext = true;
                    }
                }
                nextFrontierByRoot.set(root, next);
            }
            frontierByRoot = nextFrontierByRoot;
            if (!anyNext) break;
        }

        // C. Produced counts for every descendant across the whole subtree.
        const producedByDescendant = new Map<string, number>();
        if (allDescendants.size > 0) {
            const descRefs = sessionRefList([...allDescendants]);
            const descRows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT type::string(in) AS session, count() AS produced FROM produced WHERE in IN [${descRefs}] GROUP BY session;`,
            ))?.[0] ?? [];
            for (const r of descRows) producedByDescendant.set(String(r.session), Number(r.produced ?? 0));
        }

        for (const id of sessionIds) {
            const directCount = direct.get(id) ?? 0;
            let sub = 0;
            for (const d of descendantsByRoot.get(id) ?? []) sub += producedByDescendant.get(d) ?? 0;
            const total = directCount + sub;
            map.set(id, total === 0 ? null : sub / total);
        }
        return fillDefaults(map, sessionIds, null);
    });
