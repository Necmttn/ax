import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { editDelta } from "../dashboard/loc-query.ts";
import {
    canonicalEditToolName,
    editToolSqlFilter,
    isApplyPatchCall,
    isEditTool,
} from "./tool-classes.ts";
import { fillDefaults, sessionRefList } from "./util.ts";

export interface SessionLoc { readonly added: number; readonly removed: number; }

const PATCH_TEXT_FIELDS = ["patch", "diff", "input", "command", "cmd"] as const;

/**
 * Estimate added/removed lines for an apply_patch call (codex tool OR
 * exec_command carrying an `apply_patch <<EOF` heredoc). Counts +/- body
 * lines of the patch text, skipping the +++/--- file headers. Returns zeros
 * for shapes we can't parse so a bad row never breaks the rollup.
 */
export const applyPatchDelta = (inputJson: string | null): SessionLoc => {
    const zero = { added: 0, removed: 0 };
    if (inputJson === null) return zero;
    let input: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(inputJson);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return zero;
        input = parsed as Record<string, unknown>;
    } catch {
        return zero;
    }
    let patch: string | null = null;
    for (const field of PATCH_TEXT_FIELDS) {
        const value = input[field];
        if (typeof value === "string" && value.length > 0) { patch = value; break; }
    }
    if (patch === null) return zero;

    let added = 0;
    let removed = 0;
    for (const line of patch.split(/\r?\n/)) {
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return { added, removed };
};

/**
 * Lines added/removed per session, estimated from edit-class tool_call rows.
 * Claude Edit/Write/MultiEdit/NotebookEdit deltas come from `editDelta`;
 * codex/pi apply_patch (tool name or exec_command command_norm) deltas come
 * from counting +/- patch lines. Other shell edits (tee/patch/dd) count as
 * edits elsewhere but contribute 0/0 here (no parsable before/after).
 *
 * Bounded, deref-free read: session IN-list + stored name/command_norm
 * columns (`tool_call_session_ts` index); classification happens in JS on the
 * fetched rows (see tool-classes.ts).
 */
export const computeSessionLoc = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, SessionLoc>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, SessionLoc>();
        if (sessionIds.length === 0) return map;
        const refs = sessionRefList(sessionIds);
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, name, command_norm, input_json
FROM tool_call
WHERE session IN [${refs}] AND ${editToolSqlFilter};`))?.[0] ?? [];
        for (const r of rows) {
            const call = {
                name: String(r.name ?? ""),
                command_norm: typeof r.command_norm === "string" ? r.command_norm : null,
            };
            if (!isEditTool(call)) continue;
            const inputJson = typeof r.input_json === "string" ? r.input_json : null;
            const d = isApplyPatchCall(call)
                ? applyPatchDelta(inputJson)
                : editDelta(canonicalEditToolName(call.name), inputJson);
            const s = String(r.session);
            const cur = map.get(s) ?? { added: 0, removed: 0 };
            map.set(s, { added: cur.added + d.added, removed: cur.removed + d.removed });
        }
        return fillDefaults(map, sessionIds, { added: 0, removed: 0 });
    });
