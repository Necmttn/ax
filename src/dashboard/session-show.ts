/**
 * P2.2: ax session show - combined data fetcher.
 *
 * Pure data helper. Fetches the primary session detail plus one
 * fetchSessionDetail call per requested expansion. All calls run in parallel
 * via Effect.all.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { fetchSessionDetail } from "./session-detail.ts";
import type { SessionDetailPayload } from "../lib/shared/dashboard-types.ts";

export interface SessionShowPayload {
    /** Primary session detail. */
    readonly session: SessionDetailPayload;
    /**
     * Expanded subagent details, one entry per UUID in the `expand` set that
     * matched a child. Order mirrors the order of `session.children`.
     */
    readonly expanded_subagents: ReadonlyArray<SessionDetailPayload>;
}

export interface FetchSessionShowOptions {
    readonly sessionId: string;
    /**
     * Set of subagent session ids (UUIDs or `claude-subagent-<id>` forms) to
     * expand inline. Loose matching: a child is expanded when its session_id
     * string includes any value in this set.
     */
    readonly expand: ReadonlySet<string>;
    /** When true, expand ALL children regardless of the expand set. */
    readonly expandAll: boolean;
}

/**
 * Fetches session detail for the primary session plus any requested
 * subagent expansions. All DB calls run in parallel.
 *
 * Returns `null` for `session.overview` when the session does not exist -
 * the caller should surface that as "not found".
 */
export const fetchSessionShow = (
    opts: FetchSessionShowOptions,
): Effect.Effect<SessionShowPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const primary = yield* fetchSessionDetail(opts.sessionId);

        // Determine which children to expand
        const childrenToExpand = primary.children.filter((child) => {
            if (opts.expandAll) return true;
            const sid = String(child.session_id ?? "");
            for (const expandId of opts.expand) {
                if (sid.includes(expandId)) return true;
            }
            return false;
        });

        if (childrenToExpand.length === 0) {
            return { session: primary, expanded_subagents: [] };
        }

        const expanded = yield* Effect.all(
            childrenToExpand.map((child) =>
                fetchSessionDetail(String(child.session_id)),
            ),
            { concurrency: "unbounded" },
        );

        return { session: primary, expanded_subagents: expanded };
    });
