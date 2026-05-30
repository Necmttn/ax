import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import type { DbError } from "../lib/errors.ts";
import {
    modelQualityFromLabels,
    tokenQualityFromLabels,
    tokenSourceDetailFromLabels,
    unpricedReasonFromLabels,
    type ModelSourceQuality,
    type TokenSourceQuality,
} from "../ingest/token-quality.ts";

export interface CostSessionRow {
    readonly session: string;
    readonly source: string;
    readonly model: string | null;
    readonly estimatedTokens: number;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    readonly tokenSourceQuality: TokenSourceQuality;
    readonly tokenSourceDetail: string | null;
    readonly modelSourceQuality: ModelSourceQuality;
    readonly unpricedModelReason: string | null;
    readonly ts: string | null;
}

export interface CostSummary {
    readonly sessions: CostSessionRow[];
    readonly totals: {
        readonly sessions: number;
        readonly estimatedTokens: number;
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly cacheCreationInputTokens: number;
        readonly cacheReadInputTokens: number;
    };
    readonly byModel: ReadonlyArray<{
        readonly source: string;
        readonly model: string | null;
        readonly tokenSourceQuality: TokenSourceQuality;
        readonly sessions: number;
        readonly estimatedTokens: number;
        readonly unpricedModelReason: string | null;
    }>;
}

export interface CostSummaryInput {
    readonly limit: number;
    readonly source: string | null;
    readonly sinceDays: number | null;
}

const numberOrZero = (value: unknown): number => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const nullableNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

const stringOrNull = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const labelsRecord = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "string") return {};
    const decoded = decodeJsonOrNull(value);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? decoded as Record<string, unknown>
        : {};
};

export const mapCostRows = (rows: ReadonlyArray<Record<string, unknown>>): CostSessionRow[] =>
    rows.map((row) => {
        const promptTokens = nullableNumber(row.prompt_tokens);
        const completionTokens = nullableNumber(row.completion_tokens);
        const cacheCreationInputTokens = nullableNumber(row.cache_creation_input_tokens);
        const cacheReadInputTokens = nullableNumber(row.cache_read_input_tokens);
        const hasExplicitCounters =
            promptTokens !== null ||
            completionTokens !== null ||
            cacheCreationInputTokens !== null ||
            cacheReadInputTokens !== null;
        const labels = labelsRecord(row.labels);
        const model = stringOrNull(row.model);
        return {
            session: String(row.session ?? row.id ?? ""),
            source: String(row.source ?? ""),
            model,
            estimatedTokens: numberOrZero(row.estimated_tokens),
            promptTokens,
            completionTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            tokenSourceQuality: tokenQualityFromLabels(labels, hasExplicitCounters ? "explicit" : "estimate"),
            tokenSourceDetail: tokenSourceDetailFromLabels(labels),
            modelSourceQuality: modelQualityFromLabels(labels, model !== null),
            unpricedModelReason: unpricedReasonFromLabels(labels) ?? "pricing_not_computed",
            ts: stringOrNull(row.ts),
        };
    });

export const summarizeCostRows = (sessions: CostSessionRow[]): CostSummary => {
    const totals = sessions.reduce(
        (acc, row) => ({
            sessions: acc.sessions + 1,
            estimatedTokens: acc.estimatedTokens + row.estimatedTokens,
            promptTokens: acc.promptTokens + (row.promptTokens ?? 0),
            completionTokens: acc.completionTokens + (row.completionTokens ?? 0),
            cacheCreationInputTokens: acc.cacheCreationInputTokens + (row.cacheCreationInputTokens ?? 0),
            cacheReadInputTokens: acc.cacheReadInputTokens + (row.cacheReadInputTokens ?? 0),
        }),
        {
            sessions: 0,
            estimatedTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
        },
    );

    const buckets = new Map<string, {
        source: string;
        model: string | null;
        tokenSourceQuality: TokenSourceQuality;
        sessions: number;
        estimatedTokens: number;
        unpricedModelReason: string | null;
    }>();
    for (const row of sessions) {
        const key = [
            row.source,
            row.model ?? "",
            row.tokenSourceQuality,
            row.unpricedModelReason ?? "",
        ].join("\u0000");
        const bucket = buckets.get(key) ?? {
            source: row.source,
            model: row.model,
            tokenSourceQuality: row.tokenSourceQuality,
            sessions: 0,
            estimatedTokens: 0,
            unpricedModelReason: row.unpricedModelReason,
        };
        bucket.sessions += 1;
        bucket.estimatedTokens += row.estimatedTokens;
        buckets.set(key, bucket);
    }

    return {
        sessions,
        totals,
        byModel: [...buckets.values()].sort((a, b) => b.estimatedTokens - a.estimatedTokens),
    };
};

export const fetchCostSummary = (
    input: CostSummaryInput,
): Effect.Effect<CostSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const where: string[] = [];
        if (input.source) where.push(`source = ${JSON.stringify(input.source)}`);
        if (input.sinceDays !== null) {
            const since = Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650);
            where.push(`ts > time::now() - ${since}d`);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const limit = Math.min(Math.max(input.limit, 1), 500);
        const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, source, model,
       prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       estimated_tokens, labels, type::string(ts) AS ts
FROM session_token_usage
${whereClause}
ORDER BY ts DESC
LIMIT ${limit};`);
        return summarizeCostRows(mapCostRows(result?.[0] ?? []));
    });
