import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    RECALL_COUNT_SQL,
    RECALL_SESSIONS_FOR_SKILL_SQL,
    RECALL_TURNS_SQL,
} from "../queries/recall.ts";
import type { RecallHit, RecallResponse } from "../lib/shared/dashboard-types.ts";
import { clampPagination, type PaginationConfig } from "../lib/shared/pagination.ts";

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

const RECALL_PAGINATION: PaginationConfig = { defaultLimit: 50, maxLimit: 200 };

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
        const { offset, limit } = clampPagination(
            { offset: params.offset, limit: params.limit },
            RECALL_PAGINATION,
        );
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
        // why: the count query can legitimately return 0 (empty/missing row, or
        // a Surreal aggregate quirk if the index races a write) even when the
        // page query returned hits. Falling back to `hits.length + offset`
        // guarantees the UI never claims fewer rows than it just rendered, and
        // Math.max keeps the count monotonic if both signals disagree.
        const total_count = Math.max(
            Number.isFinite(totalFromCount) ? Math.trunc(totalFromCount) : 0,
            hits.length + offset,
        );

        return {
            q: params.q,
            hits,
            truncated: offset + hits.length < total_count,
            total_count,
            window: { offset, limit },
        };
    });
