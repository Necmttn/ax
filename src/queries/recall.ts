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

/** Sessions that invoked a specific skill (cheap; uses the invoked indexes). */
export const RECALL_SESSIONS_FOR_SKILL_SQL = `
SELECT array::distinct(in.session) AS sessions
FROM invoked
WHERE out.name = $skill
GROUP ALL
LIMIT 1;`;
