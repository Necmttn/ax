import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { isEditTool, toolClassInputOf } from "@ax/lib/shared/tool-classes";
import { isoMs, sessionIdsClause } from "./util.ts";

const EditRow = Schema.Struct({
    session: Schema.String,
    name: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});
const SessionStartRow = Schema.Struct({ session: Schema.String, started_at: Schema.NullOr(TimestampColumn) });

/**
 * Time from a session's `started_at` to its first edit, in ms. null when the
 * session never edited (distinct from 0). Edit detection is multi-provider:
 * Claude Edit/Write tools AND codex/pi apply_patch / shell edits via the
 * stored `command_norm` column (see @ax/lib/shared/tool-classes).
 *
 * Two flat set-based reads joined in JS. Edit candidates are taken from
 * `tool_call` (session/name/command_norm/ts are stored columns, indexed by
 * `tool_call_session_ts`) rather than the `edited` graph edge - the edge would
 * require an unindexed `in.session` per-edge deref to bound by session, the
 * documented hang path. Both reads are bounded by the session IN-list; the
 * first-edit min is folded in JS over the (per-session bounded) edit rows.
 */
export const computeTimeToFirstEdit = (
    read: CacheReadService,
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, CacheReadError> =>
    Effect.gen(function* () {
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const toolSessions = sessionIdsClause("session", sessionIds);

        // Edit-class tool_call rows (bounded; deref-free; classified in JS).
        const editRows = yield* read.rows(
            EditRow,
            `SELECT session, name, command_norm, ts FROM tool_call WHERE TRUE ${toolSessions.sql}`,
            toolSessions.params,
        );
        // Session start times. Record-list selection, NOT `FROM session WHERE
        // id IN [...]` - the id IN-list form silently matches nothing on some
        // tables (invariant + live verification: @ax/lib/shared/record-select).
        const sessionRows = sessionIdsClause("id", sessionIds);
        const starts = yield* read.rows(
            SessionStartRow,
            `SELECT id AS session, started_at FROM session WHERE TRUE ${sessionRows.sql}`,
            sessionRows.params,
        );

        const firstEdit = new Map<string, number>();
        for (const r of editRows) {
            const call = toolClassInputOf(r);
            if (!isEditTool(call)) continue;
            const ms = isoMs(r.ts);
            if (ms === null) continue;
            const session = String(r.session);
            const cur = firstEdit.get(session);
            if (cur === undefined || ms < cur) firstEdit.set(session, ms);
        }

        const startedBySession = new Map<string, number>();
        for (const s of starts) {
            const ms = isoMs(s.started_at);
            if (ms !== null) startedBySession.set(String(s.session), ms);
        }
        for (const [session, editMs] of firstEdit) {
            const startedMs = startedBySession.get(session);
            if (startedMs === undefined) continue;
            const ms = editMs - startedMs;
            if (ms < 0) continue;
            map.set(session, ms);
        }
        return map;
    });
