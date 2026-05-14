import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    RECALL_SESSIONS_FOR_SKILL_SQL,
    RECALL_TURNS_SQL,
} from "../queries/recall.ts";
import type { RecallHit, RecallResponse } from "../lib/shared/dashboard-types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

const recordIdString = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "toString" in v) {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
};

const truncate = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export interface RecallParams {
    readonly q: string;
    readonly project?: string | null;
    readonly skill?: string | null;
    readonly since?: string | null;
}

export const fetchRecall = (
    params: RecallParams,
): Effect.Effect<RecallResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const q = params.q.trim().toLowerCase();
        if (!q) {
            return { q: params.q, hits: [], truncated: false };
        }

        // Optional skill filter: materialise sessions first.
        let sessionFilterClause = "";
        if (params.skill && params.skill.trim()) {
            const skillRows = yield* db.query<[Array<Record<string, unknown>>]>(
                RECALL_SESSIONS_FOR_SKILL_SQL,
                { skill: params.skill.trim() },
            );
            const ids: string[] = [];
            const sessions = skillRows?.[0]?.[0]?.sessions;
            if (Array.isArray(sessions)) {
                for (const v of sessions) {
                    const id = recordIdString(v);
                    if (id) ids.push(id);
                }
            }
            if (ids.length === 0) {
                return { q: params.q, hits: [], truncated: false };
            }
            sessionFilterClause = `AND session IN [${ids.join(", ")}]`;
        }

        const bindings: Record<string, unknown> = {
            q,
            project: params.project?.trim() || null,
            since: params.since?.trim() || null,
        };

        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            RECALL_TURNS_SQL(sessionFilterClause),
            bindings,
        );

        const hits: RecallHit[] = [];
        for (const raw of rows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const session = recordIdString(raw.session);
            if (!session) continue;
            const text = stringField(raw, "text_excerpt") ?? "";
            hits.push({
                turn_id: recordIdString(raw.id) ?? "",
                session_id: session,
                project: stringField(raw, "project"),
                source: stringField(raw, "source"),
                role: stringField(raw, "role"),
                ts: dateField(raw, "ts"),
                snippet: truncate(text, 240),
            });
        }
        return {
            q: params.q,
            hits,
            truncated: hits.length >= 50,
        };
    });
