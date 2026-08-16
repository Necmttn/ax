import { Effect, Schema } from "effect";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import {
    isEditTool,
    isReadTool,
    toolClassInputOf,
} from "@ax/lib/shared/tool-classes";
import { isoMs, sessionIdsClause } from "./util.ts";

const ToolRow = Schema.Struct({
    session: Schema.String,
    name: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});

/**
 * Count of read/search tool_calls that happened BEFORE the session's first
 * edit. When the session never edited, ALL its reads/searches count. Default
 * 0. Classification is multi-provider (see @ax/lib/shared/tool-classes): Claude
 * Read/Grep/Glob + shell reads/searches (cat/sed/rg/... via the stored
 * `command_norm`); edits are Edit/Write/... + apply_patch / shell edits.
 *
 * Uses the `tool_call` name/command_norm approach rather than the
 * `read_file`/`searched_file` relation tables: tool_call has
 * session/name/command_norm/ts as stored columns indexed by
 * `tool_call_session_ts`, so the read is bounded and deref-free, where the
 * relations would need an unindexed per-edge deref to bound by session.
 */
export const computeColdStartReads = (
    read: CacheReadService,
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number>, CacheReadError> =>
    Effect.gen(function* () {
        const map = new Map<string, number>();
        if (sessionIds.length === 0) return map;

        const sessions = sessionIdsClause("session", sessionIds);
        const rows = yield* read.rows(
            ToolRow,
            `SELECT session, name, command_norm, ts FROM tool_call WHERE TRUE ${sessions.sql}`,
            sessions.params,
        );

        // Group rows per session, tracking first-edit ms and the read/search timestamps.
        const firstEdit = new Map<string, number>();
        const readMs = new Map<string, number[]>();
        for (const r of rows) {
            const session = String(r.session);
            const call = toolClassInputOf(r);
            const ms = isoMs(r.ts);
            if (isEditTool(call)) {
                if (ms === null) continue;
                const cur = firstEdit.get(session);
                if (cur === undefined || ms < cur) firstEdit.set(session, ms);
            } else if (isReadTool(call) && ms !== null) {
                const list = readMs.get(session) ?? [];
                list.push(ms);
                readMs.set(session, list);
            }
        }

        for (const id of sessionIds) {
            const reads = readMs.get(id) ?? [];
            const edit = firstEdit.get(id);
            const count = edit === undefined ? reads.length : reads.filter((ms) => ms < edit).length;
            map.set(id, count);
        }
        return map;
    });
