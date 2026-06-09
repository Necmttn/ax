import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { editDelta } from "../dashboard/loc-query.ts";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

export interface SessionLoc { readonly added: number; readonly removed: number; }

export const computeSessionLoc = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, SessionLoc>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, SessionLoc>();
        if (sessionIds.length === 0) return map;
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        const tools = EDIT_TOOLS.map((t) => surrealString(t)).join(", ");
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, name, input_json
FROM tool_call
WHERE session IN [${refs}] AND name IN [${tools}];`))?.[0] ?? [];
        for (const r of rows) {
            const s = String(r.session);
            const d = editDelta(String(r.name ?? ""), typeof r.input_json === "string" ? r.input_json : null);
            const cur = map.get(s) ?? { added: 0, removed: 0 };
            map.set(s, { added: cur.added + d.added, removed: cur.removed + d.removed });
        }
        for (const id of sessionIds) if (!map.has(id)) map.set(id, { added: 0, removed: 0 });
        return map;
    });
