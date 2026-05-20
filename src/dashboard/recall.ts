import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    RECALL_COUNT_SQL,
    RECALL_SESSIONS_FOR_SKILL_SQL,
    recallTurnsQuery,
} from "../queries/recall.ts";
import type { RecallHit, RecallResponse } from "../lib/shared/dashboard-types.ts";
import { clampPagination, type PaginationConfig } from "../lib/shared/pagination.ts";
import { isRecord, recordIdString } from "../lib/shared/row-fields.ts";
import { runQuery } from "../lib/shared/graph-query.ts";

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
        const [mapped, countRows] = yield* Effect.all(
            [
                runQuery(recallTurnsQuery, {
                    q,
                    project: baseBindings.project as string | null,
                    since: baseBindings.since as string | null,
                    offset,
                    limit,
                    sessionFilterClause,
                }),
                db.query<[Array<Record<string, unknown>>]>(
                    RECALL_COUNT_SQL(sessionFilterClause),
                    baseBindings,
                ),
            ],
            { concurrency: "unbounded" },
        );
        const hits: RecallHit[] = mapped.filter((h): h is RecallHit => h !== null);

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
