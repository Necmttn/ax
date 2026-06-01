/**
 * Recall: cross-session text search over turns.
 *
 * Uses the `turn_text_fts` BM25 full-text index on `turn.text_excerpt`
 * (defined in schema.surql). The `@@` operator delegates to the index so
 * queries return in tens of ms even on hundreds of thousands of turns -
 * the previous `string::contains` scan took 1-2s for rare terms.
 *
 * Bindings:
 *  - $q (query string, required) - tokenised by the `turn_text` analyzer
 *    (class tokenizer + lowercase + ascii filters); multi-word queries match
 *    if any token hits.
 *  - $project (optional, exact match on session.project)
 *  - $since (optional ISO datetime - only turns at or after this ts)
 *  - $offset (integer >= 0) - page start
 *  - $limit (integer 1..200) - page size
 *
 * The skill filter is handled by materialising the matching session IDs in a
 * separate cheap query and splicing them in as a SurrealQL array literal
 * (sessionFilterClause), because IN (SELECT ...) over the 600k-row
 * invoked table tanks perf (we hit this for episodes in R16-A).
 */
import { defineQuery } from "@ax/lib/shared/query";
import { isRecord, stringField, dateField, numberField, recordIdString } from "@ax/lib/shared/row-fields";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type { RecallHit, RecallCommitHit, RecallSkillHit } from "@ax/lib/shared/dashboard-types";

export const RECALL_TURNS_SQL = (sessionFilterClause: string): string => `
SELECT
    id,
    session,
    session.project AS project,
    session.source AS source,
    role,
    ts,
    text_excerpt
FROM turn
WHERE text_excerpt @@ $q
  AND ($project IS NONE OR $project IS NULL OR session.project = $project)
  AND ($since IS NONE OR $since IS NULL OR ts >= $since)
  ${sessionFilterClause}
ORDER BY ts DESC
START $offset
LIMIT $limit;`;

/** Count of total matches for the same filter set - used to compute window
 *  + drive the "load more" sentinel. Keeps bindings identical to the page
 *  query (minus $offset/$limit). */
export const RECALL_COUNT_SQL = (sessionFilterClause: string): string => `
SELECT count() AS total
FROM turn
WHERE text_excerpt @@ $q
  AND ($project IS NONE OR $project IS NULL OR session.project = $project)
  AND ($since IS NONE OR $since IS NULL OR ts >= $since)
  ${sessionFilterClause}
GROUP ALL;`;

/**
 * BM25 full-text search over commit messages.
 *
 * `scopeClause` is either an empty string or `AND repository = $repository`
 * (injected when scope=here).
 */
export const RECALL_COMMITS_SQL = (scopeClause: string): string => `
SELECT
    id,
    sha,
    repo,
    repository,
    ts,
    search::highlight("<mark>", "</mark>", 1) AS snippet,
    search::score(1) AS score
FROM commit
WHERE message @1@ $q
  ${scopeClause}
ORDER BY score DESC
LIMIT $limit;`;

/** Count of total commit matches (for total_counts). Omits $limit. */
export const RECALL_COMMITS_COUNT_SQL = (scopeClause: string): string => `
SELECT count() AS total
FROM commit
WHERE message @1@ $q
  ${scopeClause}
GROUP ALL;`;

/**
 * BM25 full-text search over skill name + description.
 *
 * Uses `@1@` / `@2@` predicates matching skill_search_name /
 * skill_search_desc indexes (defined in schema.surql). Scope=here doesn't
 * apply to skills (catalog is global).
 */
export const RECALL_SKILLS_SQL = `
SELECT
    id,
    name,
    description,
    search::highlight("<mark>", "</mark>", 1) AS snippet,
    math::max([search::score(1), search::score(2), 0]) AS score
FROM skill
WHERE name @1@ $q OR description @2@ $q
ORDER BY score DESC
LIMIT $limit;`;

/** Count of total skill matches (for total_counts). */
export const RECALL_SKILLS_COUNT_SQL = `
SELECT count() AS total
FROM skill
WHERE name @1@ $q OR description @2@ $q
GROUP ALL;`;

/** Sessions that invoked a specific skill (cheap; uses the invoked indexes). */
export const RECALL_SESSIONS_FOR_SKILL_SQL = `
SELECT array::distinct(in.session) AS sessions
FROM invoked
WHERE out.name = $skill
GROUP ALL
LIMIT 1;`;

// ---------------------------------------------------------------------------
// Typed Query seam
// ---------------------------------------------------------------------------

export interface RecallTurnsParams {
    readonly q: string;
    readonly project: string | null;
    readonly since: string | null;
    readonly offset: number;
    readonly limit: number;
    readonly sessionFilterClause: string;
}

const truncate = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export const recallTurnsQuery = defineQuery<
    RecallTurnsParams,
    Record<string, unknown>,
    RecallHit | null
>({
    name: "recall.turns",
    sql: (p) => RECALL_TURNS_SQL(p.sessionFilterClause),
    bindings: (p) => ({
        q: p.q,
        project: p.project,
        since: p.since,
        offset: p.offset,
        limit: p.limit,
    }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const session = recordIdString(raw.session);
        if (!session) return null;
        const text = stringField(raw, "text_excerpt") ?? "";
        return {
            turn_id: recordIdString(raw.id) ?? "",
            session_id: toBareSessionId(session),
            project: stringField(raw, "project"),
            source: stringField(raw, "source"),
            role: stringField(raw, "role"),
            ts: dateField(raw, "ts"),
            snippet: truncate(text, 240),
        };
    },
});

// ---------------------------------------------------------------------------
// Commits query
// ---------------------------------------------------------------------------

export interface RecallCommitsParams {
    readonly q: string;
    readonly limit: number;
    readonly scopeClause: string;
    readonly repository?: string | null;
}

export const recallCommitsQuery = defineQuery<
    RecallCommitsParams,
    Record<string, unknown>,
    RecallCommitHit | null
>({
    name: "recall.commits",
    sql: (p) => RECALL_COMMITS_SQL(p.scopeClause),
    bindings: (p) => ({
        q: p.q,
        limit: p.limit,
        ...(p.repository != null ? { repository: p.repository } : {}),
    }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const commit_id = recordIdString(raw.id) ?? "";
        const sha = stringField(raw, "sha") ?? "";
        return {
            commit_id,
            sha,
            repo: stringField(raw, "repo"),
            repository: recordIdString(raw.repository),
            ts: dateField(raw, "ts"),
            snippet: stringField(raw, "snippet") ?? sha,
            score: numberField(raw, "score") ?? 0,
        };
    },
});

// ---------------------------------------------------------------------------
// Skills query
// ---------------------------------------------------------------------------

export interface RecallSkillsParams {
    readonly q: string;
    readonly limit: number;
}

export const recallSkillsQuery = defineQuery<
    RecallSkillsParams,
    Record<string, unknown>,
    RecallSkillHit | null
>({
    name: "recall.skills",
    sql: () => RECALL_SKILLS_SQL,
    bindings: (p) => ({ q: p.q, limit: p.limit }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const skill_id = recordIdString(raw.id) ?? "";
        const name = stringField(raw, "name") ?? "";
        return {
            skill_id,
            name,
            description: stringField(raw, "description"),
            snippet: stringField(raw, "snippet") ?? name,
            score: numberField(raw, "score") ?? 0,
        };
    },
});
