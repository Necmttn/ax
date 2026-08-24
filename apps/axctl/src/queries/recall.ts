/**
 * `ax recall` on DuckDB - the wave-2 port template.
 *
 * WHAT CHANGED FROM THE SURREAL VERSION, and why each change is forced:
 *
 *  - BM25 moved from `text_excerpt @@ $q` to
 *    `fts_main_turn.match_bm25(t.id, ?)`, which returns a SCORE (NULL when the
 *    row does not match) rather than acting as a boolean operator. So the match
 *    is computed once in a subquery and filtered with `score IS NOT NULL`
 *    outside it - not repeated in SELECT and WHERE, which would bind the query
 *    text twice and score every row twice.
 *  - Surreal record DEREFS (`session.project`, `session.repository`) became a
 *    real `JOIN session`. DuckDB has no record links: `turn.session` is a plain
 *    VARCHAR holding the session's row id.
 *  - `search::highlight(...)` has no DuckDB equivalent. Snippets are the raw
 *    column, truncated in JS - which is exactly what the turn source already
 *    did, so commits and skills now behave the same way instead of two
 *    different ways.
 *  - The skill FTS index is GONE (issue #758): the catalogue is small enough
 *    that an `ILIKE` scan beats an index that cost more to build than the scan
 *    it replaced. Ranking is a name-hit-beats-description-hit CASE, which is
 *    what the old `math::max(score(1), score(2))` amounted to in practice.
 *  - EVERY filter is a BOUND PARAMETER. The Surreal version was forced to splice
 *    record-id literals into the SQL text (`AND session IN [session:a, ...]`,
 *    `AND repository = repository:...`) because Surreal bindings cannot carry
 *    record-id arrays. DuckDB row ids are plain strings, so that whole class of
 *    string-built SQL - and the injection surface with it - disappears. The
 *    tests assert the generated SQL contains no quote characters.
 *
 * Filter clauses are appended only when a filter is PRESENT, rather than using
 * `(? IS NULL OR col = ?)` guards: positional parameters would then have to be
 * bound twice per optional filter, which is the kind of off-by-one that produces
 * a wrong answer rather than an error.
 */
import { Schema } from "effect";
import {
    andAll,
    eqClause,
    inClause,
    NO_CLAUSE,
    sinceClause,
    type Clause,
} from "@ax/lib/duckdb/clause";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { COMMIT_FTS_TARGET, matchBm25Sql, TURN_FTS_TARGET, type FtsTarget } from "@ax/lib/duckdb/fts";

/** Re-exported FROM the fts module (#921) so the reader can never drift from
 *  the target `buildFtsIndexes` actually indexes. Turn search covers the FULL
 *  `turn.text` since #921 (was the 500-char `text_excerpt` - a phrase past
 *  that bound was silently unfindable). */
export const TURN_FTS: FtsTarget = TURN_FTS_TARGET;
export const COMMIT_FTS: FtsTarget = COMMIT_FTS_TARGET;

/** How much of a matched turn/commit/skill body a hit carries. */
export const SNIPPET_MAX = 240;

export const truncate = (text: string, max: number = SNIPPET_MAX): string =>
    text.length <= max ? text : `${text.slice(0, max)}…`;

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export const TurnHitRow = Schema.Struct({
    turn_id: Schema.String,
    session_id: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    role: Schema.String,
    ts: TimestampColumn,
    text_excerpt: Schema.NullOr(Schema.String),
});

export interface TurnFilters {
    readonly q: string;
    readonly project?: string | null;
    readonly since?: string | null;
    readonly sessionIds?: ReadonlyArray<string> | null;
    readonly repositoryId?: string | null;
}

const turnWhere = (filters: TurnFilters): Clause =>
    andAll([
        eqClause("s.project", filters.project),
        sinceClause("t.ts", filters.since),
        filters.sessionIds ? inClause("t.session", filters.sessionIds) : NO_CLAUSE,
        eqClause("s.repository", filters.repositoryId),
    ]);

/**
 * The first whitespace-delimited term of the query, used ONLY for the snippet's
 * literal-substring window (#1023). BM25 matches conjunctively across all terms
 * but the terms need not be adjacent, so `position("duckdb spool" IN text)`
 * usually returns 0 and the snippet fell back to the unrelated head excerpt.
 * Windowing on the first term instead makes the match visible. A single-term
 * query is unchanged (first term === whole query).
 */
const firstTerm = (q: string): string => q.trim().split(/\s+/)[0] ?? q;

/**
 * The scored, filtered turn set - shared by the page query and the count query
 * so the two can never disagree about what "matching" means. `?` #1 is the
 * query text; the rest are the filters' own parameters, in order.
 */
const turnMatchesSql = (where: Clause): string => `
    SELECT
        t.id AS turn_id,
        t.session AS session_id,
        s.project AS project,
        s.source AS source,
        s.cwd AS cwd,
        t.role AS role,
        t.ts AS ts,
        -- #921/#1023: the index covers FULL turn text, so a hit can sit past
        -- the 500-char excerpt. Show a match-centered window from the full text
        -- around the FIRST query term (bm25 matches all terms but not
        -- necessarily adjacently, so the joined phrase is rarely locatable);
        -- fall back to the stored head excerpt when even that term is absent
        -- (pure-stemming matches).
        COALESCE(
            CASE WHEN position(lower(?) IN lower(t.text)) > 0
                 THEN substr(t.text, CASE WHEN position(lower(?) IN lower(t.text)) > 120
                                          THEN position(lower(?) IN lower(t.text)) - 120 ELSE 1 END, 360)
            END,
            t.text_excerpt
        ) AS text_excerpt,
        ${matchBm25Sql(TURN_FTS, "t", { conjunctive: true })} AS score
    FROM turn t
    JOIN session s ON s.id = t.session
    WHERE TRUE ${where.sql}
`;

export const turnPageQuery = (filters: TurnFilters, offset: number, limit: number): Clause => {
    const where = turnWhere(filters);
    const snippet = firstTerm(filters.q);
    return {
        // Rank by RELEVANCE (bm25 score), recency as the tie-break (#1023). The
        // score column lives in the `matches` subquery, so ORDER BY reads it
        // even though the outer SELECT does not project it - the row shape the
        // reader decodes is unchanged.
        sql: `SELECT turn_id, session_id, project, source, cwd, role, ts, text_excerpt
              FROM (${turnMatchesSql(where)}) matches
              WHERE score IS NOT NULL
              ORDER BY score DESC, ts DESC
              LIMIT ? OFFSET ?`,
        params: [snippet, snippet, snippet, filters.q, ...where.params, limit, offset],
    };
};

export const turnCountQuery = (filters: TurnFilters): Clause => {
    const where = turnWhere(filters);
    const snippet = firstTerm(filters.q);
    return {
        sql: `SELECT count(*) AS total FROM (${turnMatchesSql(where)}) matches WHERE score IS NOT NULL`,
        // Same subquery as the page query, so the same FOUR binds: 3 snippet
        // (first term) + 1 match_bm25 (full query). The optimizer prunes the
        // unused snippet column, but the placeholders still need their params.
        // For a single-term query all four are the same string.
        params: [snippet, snippet, snippet, filters.q, ...where.params],
    };
};

/** Sessions that invoked a skill by name. Uses `invoked.session` - denormalized
 *  onto the edge precisely so this does not have to walk turn -> session. */
export const sessionsForSkillQuery = (skill: string): Clause => ({
    sql: `SELECT DISTINCT i.session AS session_id
          FROM invoked i
          JOIN skill sk ON sk.id = i.out_id
          WHERE sk.name = ? AND i.session IS NOT NULL`,
    params: [skill],
});

/** Sessions whose tool outputs include any of `categories`. Uses
 *  `has_content.session` - denormalized for the same reason. */
export const sessionsForContentTypesQuery = (categories: ReadonlyArray<string>): Clause => ({
    sql: `SELECT DISTINCT h.session AS session_id
          FROM has_content h
          JOIN content_type ct ON ct.id = h.out_id
          WHERE h.session IS NOT NULL AND ct.category IN (${categories.map(() => "?").join(", ")})`,
    params: categories,
});

export const SessionIdRow = Schema.Struct({ session_id: Schema.String });
export const CountRow = Schema.Struct({ total: Schema.BigInt });

// ---------------------------------------------------------------------------
// Filter pickers (`--project=?`, `--skill=?`)
// ---------------------------------------------------------------------------

/** How many distinct values each picker offers to match against. Generous
 *  enough that a real filter is always in the list, bounded so an interactive
 *  prompt over a large graph stays instant. */
export const PROJECT_PICKER_LIMIT = 200;
export const SKILL_PICKER_LIMIT = 500;

export const PickerRow = Schema.Struct({ value: Schema.String, uses: Schema.BigInt });

/**
 * The tie-break every picker orders by after `uses DESC`. `uses` alone is not a
 * total order: two equally-used projects (or skills) can come back in either
 * order, and DuckDB is free to change which one on any plan, thread count or
 * row layout. That is a real defect and not merely a flaky test - the list is
 * an INTERACTIVE prompt, so the same graph would offer the same two entries in
 * a different order run to run, and `LIMIT` would drop an arbitrary one of a
 * tied pair at the cut-off. `value` is unique per row here (both queries group
 * by it), so appending it makes the order total and therefore reproducible.
 */
const PICKER_ORDER = "ORDER BY uses DESC, value ASC";

/** Projects by session count. */
export const projectPickerQuery = (): Clause => ({
    sql: `SELECT project AS value, count(*) AS uses
          FROM session
          WHERE project IS NOT NULL AND project <> ''
          GROUP BY project
          ${PICKER_ORDER}
          LIMIT ${PROJECT_PICKER_LIMIT}`,
    params: [],
});

/** Skills by invocation count. The Surreal version read `out.name` off each
 *  edge - a per-edge deref over the whole `invoked` table; here it is a join
 *  the planner can hash, which is the same reason the recall turn query joins
 *  `session` rather than dereferencing it. */
export const skillPickerQuery = (): Clause => ({
    sql: `SELECT sk.name AS value, count(*) AS uses
          FROM invoked i
          JOIN skill sk ON sk.id = i.out_id
          WHERE sk.name IS NOT NULL
          GROUP BY sk.name
          ${PICKER_ORDER}
          LIMIT ${SKILL_PICKER_LIMIT}`,
    params: [],
});

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export const CommitHitRow = Schema.Struct({
    commit_id: Schema.String,
    sha: Schema.String,
    repo: Schema.String,
    repository: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
    message: Schema.NullOr(Schema.String),
    score: Schema.Number,
});

const commitMatchesSql = (where: Clause): string => `
    SELECT
        c.id AS commit_id,
        c.sha AS sha,
        c.repo AS repo,
        c.repository AS repository,
        c.ts AS ts,
        c.message AS message,
        ${matchBm25Sql(COMMIT_FTS, "c", { conjunctive: true })} AS score
    FROM "commit" c
    WHERE TRUE ${where.sql}
`;

export const commitPageQuery = (
    q: string,
    repositoryId: string | null | undefined,
    limit: number,
): Clause => {
    const where = eqClause("c.repository", repositoryId);
    return {
        sql: `SELECT commit_id, sha, repo, repository, ts, message, score
              FROM (${commitMatchesSql(where)}) matches
              WHERE score IS NOT NULL
              ORDER BY score DESC
              LIMIT ?`,
        params: [q, ...where.params, limit],
    };
};

export const commitCountQuery = (q: string, repositoryId: string | null | undefined): Clause => {
    const where = eqClause("c.repository", repositoryId);
    return {
        sql: `SELECT count(*) AS total FROM (${commitMatchesSql(where)}) matches WHERE score IS NOT NULL`,
        params: [q, ...where.params],
    };
};

// ---------------------------------------------------------------------------
// Skills (plain SQL - the ngram FTS index was dropped in #758)
// ---------------------------------------------------------------------------

export const SkillHitRow = Schema.Struct({
    skill_id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    score: Schema.Number,
});

/** `%q%`, with LIKE's own wildcards escaped so a query containing `%` or `_`
 *  searches for those characters instead of matching everything. */
export const likePattern = (q: string): string => `%${q.replace(/([\\%_])/g, "\\$1")}%`;

const SKILL_WHERE = "WHERE (name ILIKE ? ESCAPE '\\' OR description ILIKE ? ESCAPE '\\')";

export const skillPageQuery = (q: string, limit: number): Clause => {
    const pattern = likePattern(q);
    return {
        // A name hit outranks a description-only hit - what the Surreal
        // `math::max(search::score(1), search::score(2))` amounted to, without
        // an index whose build cost exceeded the scan it replaced.
        sql: `SELECT id AS skill_id, name, description,
                     CASE WHEN name ILIKE ? ESCAPE '\\' THEN 2 ELSE 1 END AS score
              FROM skill
              ${SKILL_WHERE}
              ORDER BY score DESC, name ASC
              LIMIT ?`,
        params: [pattern, pattern, pattern, limit],
    };
};

export const skillCountQuery = (q: string): Clause => {
    const pattern = likePattern(q);
    return {
        sql: `SELECT count(*) AS total FROM skill ${SKILL_WHERE}`,
        params: [pattern, pattern],
    };
};
