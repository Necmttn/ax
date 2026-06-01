import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";

export interface CostSessionRow {
    readonly session: string;
    readonly source: string;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly estimated_tokens: number;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly estimated_cost_usd: number | null;
    readonly pricing_source: string | null;
    readonly evidence: string;
}

export interface CostSummary {
    readonly selector: string;
    readonly evidence: string;
    readonly sessions: CostSessionRow[];
    readonly totals: {
        readonly sessions: number;
        readonly estimatedTokens: number;
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly cacheCreationInputTokens: number;
        readonly cacheReadInputTokens: number;
        readonly estimatedCostUsd: number;
    };
    readonly byModel: ReadonlyArray<{
        readonly source: string;
        readonly model: string | null;
        readonly sessions: number;
        readonly estimatedTokens: number;
        readonly estimatedCostUsd: number;
    }>;
}

export type CostSelector =
    | { readonly kind: "session"; readonly sessionId: string }
    | {
        readonly kind: "query";
        readonly q?: string;
        readonly terms?: readonly string[];
        readonly limit: number;
        readonly since?: Date | null;
        readonly project?: string | null;
        readonly repositoryKey?: string | null;
    }
    | { readonly kind: "commit"; readonly sha: string; readonly repositoryKey?: string | null }
    | { readonly kind: "branch"; readonly branch: string; readonly repositoryKey?: string | null; readonly limit: number };

const numberOrZero = (value: unknown): number => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
};

const nullableNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const stringOrNull = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const toRecordRef = (table: string, id: string): string => {
    let key = id.trim().replace(new RegExp(`^${table}:`), "");
    if (key.startsWith("⟨") && key.endsWith("⟩")) key = key.slice(1, -1);
    if (key.startsWith("`") && key.endsWith("`")) key = key.slice(1, -1);
    return recordLiteral(table, key);
};

const toSessionRecord = (sessionId: string): string => toRecordRef("session", sessionId);

const mapCostRows = (rows: ReadonlyArray<Record<string, unknown>>): CostSessionRow[] =>
    rows.map((row) => ({
        session: String(row.session ?? row.id ?? ""),
        source: String(row.source ?? ""),
        model: stringOrNull(row.model),
        started_at: stringOrNull(row.started_at),
        estimated_tokens: numberOrZero(row.estimated_tokens),
        prompt_tokens: nullableNumber(row.prompt_tokens),
        completion_tokens: nullableNumber(row.completion_tokens),
        cache_creation_input_tokens: nullableNumber(row.cache_creation_input_tokens),
        cache_read_input_tokens: nullableNumber(row.cache_read_input_tokens),
        estimated_cost_usd: nullableNumber(row.estimated_cost_usd),
        pricing_source: stringOrNull(row.pricing_source),
        evidence: String(row.evidence ?? ""),
    }));

const summarize = (selector: string, evidence: string, sessions: CostSessionRow[]): CostSummary => {
    const totals = sessions.reduce(
        (acc, row) => ({
            sessions: acc.sessions + 1,
            estimatedTokens: acc.estimatedTokens + row.estimated_tokens,
            promptTokens: acc.promptTokens + (row.prompt_tokens ?? 0),
            completionTokens: acc.completionTokens + (row.completion_tokens ?? 0),
            cacheCreationInputTokens: acc.cacheCreationInputTokens + (row.cache_creation_input_tokens ?? 0),
            cacheReadInputTokens: acc.cacheReadInputTokens + (row.cache_read_input_tokens ?? 0),
            estimatedCostUsd: acc.estimatedCostUsd + (row.estimated_cost_usd ?? 0),
        }),
        {
            sessions: 0,
            estimatedTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedCostUsd: 0,
        },
    );
    const buckets = new Map<string, { source: string; model: string | null; sessions: number; estimatedTokens: number; estimatedCostUsd: number }>();
    for (const row of sessions) {
        const key = `${row.source}\u0000${row.model ?? ""}`;
        const bucket = buckets.get(key) ?? {
            source: row.source,
            model: row.model,
            sessions: 0,
            estimatedTokens: 0,
            estimatedCostUsd: 0,
        };
        bucket.sessions += 1;
        bucket.estimatedTokens += row.estimated_tokens;
        bucket.estimatedCostUsd += row.estimated_cost_usd ?? 0;
        buckets.set(key, bucket);
    }
    return {
        selector,
        evidence,
        sessions,
        totals,
        byModel: [...buckets.values()].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
    };
};

const costRowsForSessionWhere = (
    where: string,
    evidence: string,
    limit: number,
): Effect.Effect<CostSessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, source, model, type::string(session.started_at) AS started_at,
       prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       estimated_tokens, estimated_cost_usd, pricing_source, ${surrealString(evidence)} AS evidence
FROM session_token_usage
WHERE ${where}
ORDER BY started_at DESC
LIMIT ${Math.min(Math.max(limit, 1), 500)};`);
        return mapCostRows(result?.[0] ?? []);
    });

const repositoryClause = (repositoryKey: string | null | undefined): string =>
    repositoryKey ? ` AND repository = ${recordLiteral("repository", repositoryKey)}` : "";

const checkoutRepositoryClause = (repositoryKey: string | null | undefined): string =>
    repositoryKey ? ` AND repository = ${recordLiteral("repository", repositoryKey)}` : "";

const producedRepositoryClause = (repositoryKey: string | null | undefined): string =>
    repositoryKey ? `repository = ${recordLiteral("repository", repositoryKey)} AND ` : "";

const emptySummary = (selector: string, evidence: string): CostSummary => summarize(selector, evidence, []);

const querySessionClauses = (selector: Extract<CostSelector, { kind: "query" }>): string[] => {
    const clauses: string[] = [];
    if (selector.since) clauses.push(`session.started_at >= ${surrealDate(selector.since)}`);
    if (selector.project) {
        const project = surrealString(selector.project);
        clauses.push(`(session.cwd = ${project} OR session.project = ${project})`);
    }
    if (selector.repositoryKey) {
        clauses.push(`session.repository = ${recordLiteral("repository", selector.repositoryKey)}`);
    }
    return clauses;
};

const queryTerms = (selector: Extract<CostSelector, { kind: "query" }>): string[] => {
    const terms = selector.terms ?? (selector.q === undefined ? [] : [selector.q]);
    return [...new Set(terms.map((term) => term.trim()).filter((term) => term.length > 0))];
};

const recordRefsFromRows = (table: string, rows: ReadonlyArray<Record<string, unknown>>): string[] =>
    rows
        .map((row) => stringOrNull(row.id))
        .filter((id): id is string => id !== null)
        .map((id) => toRecordRef(table, id));

export const fetchCostSummary = (
    selector: CostSelector,
): Effect.Effect<CostSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (selector.kind === "session") {
            const sessionRef = toSessionRecord(selector.sessionId);
            const rows = yield* costRowsForSessionWhere(`session = ${sessionRef}`, "session_token_usage.session", 1);
            return summarize(`session:${selector.sessionId}`, "direct session_token_usage row", rows);
        }

        if (selector.kind === "query") {
            const db = yield* SurrealClient;
            const limit = Math.min(Math.max(selector.limit, 1), 100);
            const terms = queryTerms(selector);
            const clauses = querySessionClauses(selector);
            const sessionWhere = clauses.length > 0 ? `${clauses.join("\n  AND ")}\n  AND ` : "";
            const textWhere = terms.length === 0
                ? "text_excerpt @0@ \"\""
                : terms.map((term) => `text_excerpt @0@ ${surrealString(term)}`).join("\n       OR ");
            const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, source, model, type::string(session.started_at) AS started_at,
       prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       estimated_tokens, estimated_cost_usd, pricing_source, "turn_text_search" AS evidence
FROM session_token_usage
WHERE ${sessionWhere}session IN (
    SELECT VALUE session FROM turn
    WHERE ${textWhere}
    GROUP BY session
    LIMIT ${limit}
)
ORDER BY started_at DESC
LIMIT ${limit};`);
            return summarize(`query:${terms.join("|")}`, "sessions with matching turn text", mapCostRows(result?.[0] ?? []));
        }

        if (selector.kind === "commit") {
            const db = yield* SurrealClient;
            const repo = repositoryClause(selector.repositoryKey);
            const commitResult = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(id) AS id
FROM commit
WHERE (sha = ${surrealString(selector.sha)} OR sha CONTAINS ${surrealString(selector.sha)})${repo}
LIMIT 50;`);
            const commitRefs = recordRefsFromRows("commit", commitResult?.[0] ?? []);
            if (commitRefs.length === 0) {
                return emptySummary(`commit:${selector.sha}`, "no matching commit node");
            }
            const rows = yield* costRowsForSessionWhere(
                `session IN (SELECT VALUE in FROM produced WHERE ${producedRepositoryClause(selector.repositoryKey)}out IN [${commitRefs.join(", ")}])`,
                "session->produced->commit",
                100,
            );
            return summarize(`commit:${selector.sha}`, "sessions that produced the commit", rows);
        }

        const db = yield* SurrealClient;
        const checkoutResult = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(id) AS id
FROM checkout
WHERE branch = ${surrealString(selector.branch)}${checkoutRepositoryClause(selector.repositoryKey)}
LIMIT 50;`);
        const checkoutRefs = recordRefsFromRows("checkout", checkoutResult?.[0] ?? []);
        if (checkoutRefs.length === 0) {
            return emptySummary(`branch:${selector.branch}`, "no matching checkout node");
        }
        const rows = yield* costRowsForSessionWhere(
            `session IN (
                SELECT VALUE in FROM produced
                WHERE ${producedRepositoryClause(selector.repositoryKey)}checkout IN [${checkoutRefs.join(", ")}]
            )`,
            "sessions that produced commits from a branch checkout",
            selector.limit,
        );
        return summarize(`branch:${selector.branch}`, "sessions linked to branch checkout commits", rows);
    });
