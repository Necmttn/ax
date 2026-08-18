import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { fillDefaults, sessionIdsClause } from "./util.ts";

const ProducedCountRow = Schema.Struct({
    session: Schema.String,
    produced: NumberFromBigIntColumn,
});
const SpawnRow = Schema.Struct({ parent: Schema.String, child: Schema.String });

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
    read: CacheReadService,
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, CacheReadError> =>
    Effect.gen(function* () {
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;

        const roots = sessionIdsClause("in_id", sessionIds);

        // A. Direct produced count per root session.
        const directRows = yield* read.rows(
            ProducedCountRow,
            `SELECT in_id AS session, count(*) AS produced FROM produced WHERE TRUE ${roots.sql} GROUP BY in_id`,
            roots.params,
        );
        const direct = new Map<string, number>();
        for (const r of directRows) direct.set(r.session, r.produced);

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

            const frontier = sessionIdsClause("in_id", [...frontierNodes]);
            const spawnRows = yield* read.rows(
                SpawnRow,
                `SELECT in_id AS parent, out_id AS child FROM spawned WHERE TRUE ${frontier.sql}`,
                frontier.params,
            );
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
            const descendants = sessionIdsClause("in_id", [...allDescendants]);
            const descRows = yield* read.rows(
                ProducedCountRow,
                `SELECT in_id AS session, count(*) AS produced FROM produced WHERE TRUE ${descendants.sql} GROUP BY in_id`,
                descendants.params,
            );
            for (const r of descRows) producedByDescendant.set(r.session, r.produced);
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
