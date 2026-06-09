import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const isoMs = (iso: unknown): number | null => {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
};

/**
 * Time from a session's `started_at` to its first edit, in ms. null when the
 * session never edited (distinct from 0).
 *
 * Two flat set-based reads joined in JS. The first edit is taken from
 * `tool_call` (session/name/ts are stored columns, indexed by
 * `tool_call_session_ts`) rather than the `edited` graph edge - the edge would
 * require an unindexed `in.session` per-edge deref to bound by session, the
 * documented hang path. Both reads are bounded by the session IN-list.
 */
export const computeTimeToFirstEdit = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const refs = sessionIds.map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? "")).join(", ");
        const tools = EDIT_TOOLS.map((t) => surrealString(t)).join(", ");

        // First edit per session (bounded; deref-free aggregate).
        const firstEdits = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(session) AS session, type::string(time::min(ts)) AS first_edit`
            + ` FROM tool_call WHERE session IN [${refs}] AND name IN [${tools}] GROUP BY session;`,
        ))?.[0] ?? [];
        // Session start times.
        const starts = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(id) AS session, type::string(started_at) AS started_at`
            + ` FROM session WHERE id IN [${refs}];`,
        ))?.[0] ?? [];

        const startedBySession = new Map<string, number>();
        for (const s of starts) {
            const ms = isoMs(s.started_at);
            if (ms !== null) startedBySession.set(String(s.session), ms);
        }
        for (const r of firstEdits) {
            const session = String(r.session);
            const editMs = isoMs(r.first_edit);
            const startedMs = startedBySession.get(session);
            if (editMs === null || startedMs === undefined) continue;
            const ms = editMs - startedMs;
            if (ms < 0) continue;
            map.set(session, ms);
        }
        return map;
    });
