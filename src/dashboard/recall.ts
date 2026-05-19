import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    RECALL_COUNT_SQL,
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp the requested page size into a defensible range. Exported so the
 *  HTTP layer and tests share the exact same rule. */
export function clampRecallLimit(value: number | undefined): number {
    const n = Math.trunc(value ?? DEFAULT_LIMIT);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, n);
}

/** Clamp offset to a non-negative integer. */
export function clampRecallOffset(value: number | undefined): number {
    const n = Math.trunc(value ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
}

export interface RecallParams {
    readonly q: string;
    readonly project?: string | null;
    readonly skill?: string | null;
    readonly since?: string | null;
    readonly offset?: number;
    readonly limit?: number;
}

export const fetchRecall = (
    params: RecallParams,
): Effect.Effect<RecallResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const q = params.q.trim().toLowerCase();
        const offset = clampRecallOffset(params.offset);
        const limit = clampRecallLimit(params.limit);
        if (!q) {
            return {
                q: params.q,
                hits: [],
                truncated: false,
                total_count: 0,
                window: { offset, limit },
            };
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
                return {
                    q: params.q,
                    hits: [],
                    truncated: false,
                    total_count: 0,
                    window: { offset, limit },
                };
            }
            sessionFilterClause = `AND session IN [${ids.join(", ")}]`;
        }

        const baseBindings: Record<string, unknown> = {
            q,
            project: params.project?.trim() || null,
            since: params.since?.trim() || null,
        };

        // Run page + count concurrently. Count is independent of offset/limit
        // and uses the same WHERE filter set, so the answer is stable across
        // pages of the same query.
        const [pageRows, countRows] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(
                    RECALL_TURNS_SQL(sessionFilterClause),
                    { ...baseBindings, offset, limit },
                ),
                db.query<[Array<Record<string, unknown>>]>(
                    RECALL_COUNT_SQL(sessionFilterClause),
                    baseBindings,
                ),
            ],
            { concurrency: "unbounded" },
        );

        const hits: RecallHit[] = [];
        for (const raw of pageRows?.[0] ?? []) {
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

        const countRow = countRows?.[0]?.[0];
        const totalFromCount = isRecord(countRow)
            ? Number(countRow.total ?? 0)
            : 0;
        const total_count = Number.isFinite(totalFromCount) && totalFromCount > 0
            ? Math.trunc(totalFromCount)
            : hits.length + offset;

        return {
            q: params.q,
            hits,
            truncated: offset + hits.length < total_count,
            total_count,
            window: { offset, limit },
        };
    });
