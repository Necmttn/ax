import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { editToolSqlFilter, isEditTool, toolClassInputOf } from "@ax/lib/shared/tool-classes";
import { isoMs, sessionRefList } from "./util.ts";

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
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        for (const id of sessionIds) map.set(id, null);

        const refs = sessionRefList(sessionIds);

        // Edit-class tool_call rows (bounded; deref-free; classified in JS).
        const editRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(session) AS session, name, command_norm, type::string(ts) AS ts`
            + ` FROM tool_call WHERE session IN [${refs}] AND ${editToolSqlFilter};`,
        ))?.[0] ?? [];
        // Session start times. Direct record access (`FROM [refs]`), NOT
        // `FROM session WHERE id IN [...]` - the latter silently matches
        // nothing on the live DB (primary-id IN lookup misses; verified
        // 2026-06-10 while dogfooding #170), which made every ttfe null.
        const starts = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(id) AS session, type::string(started_at) AS started_at`
            + ` FROM [${refs}];`,
        ))?.[0] ?? [];

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
