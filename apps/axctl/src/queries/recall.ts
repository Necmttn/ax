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
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { matchBm25Sql, type FtsTarget } from "@ax/lib/duckdb/fts";
import type { DuckDbParam } from "@ax/lib/duckdb";

export const TURN_FTS: FtsTarget = { table: "turn", idColumn: "id", textColumn: "text_excerpt" };
export const COMMIT_FTS: FtsTarget = { table: "commit", idColumn: "id", textColumn: "message" };

/** How much of a matched turn/commit/skill body a hit carries. */
export const SNIPPET_MAX = 240;

export const truncate = (text: string, max: number = SNIPPET_MAX): string =>
    text.length <= max ? text : `${text.slice(0, max)}…`;

/** A SQL fragment plus the parameters it binds, kept together so they cannot
 *  drift apart as clauses are composed. */
export interface Clause {
    readonly sql: string;
    readonly params: ReadonlyArray<DuckDbParam>;
}

const NO_CLAUSE: Clause = { sql: "", params: [] };

const andAll = (clauses: ReadonlyArray<Clause>): Clause => {
    const live = clauses.filter((c) => c.sql.length > 0);
    return {
        sql: live.map((c) => c.sql).join(" "),
        params: live.flatMap((c) => [...c.params]),
    };
};

/** `AND <column> IN (?, ?, …)`, or nothing when `values` is empty. Callers treat
 *  an empty id set as "no possible hits" and short-circuit before reaching here. */
export const inClause = (column: string, values: ReadonlyArray<string>): Clause =>
    values.length === 0
        ? NO_CLAUSE
        : { sql: `AND ${column} IN (${values.map(() => "?").join(", ")})`, params: values };

export const eqClause = (column: string, value: string | null | undefined): Clause =>
    value === null || value === undefined || value.length === 0
        ? NO_CLAUSE
        : { sql: `AND ${column} = ?`, params: [value] };

export const sinceClause = (column: string, since: string | null | undefined): Clause =>
    since === null || since === undefined || since.length === 0
        ? NO_CLAUSE
        : { sql: `AND ${column} >= ?`, params: [since] };

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
        t.text_excerpt AS text_excerpt,
        ${matchBm25Sql(TURN_FTS, "t")} AS score
    FROM turn t
    JOIN session s ON s.id = t.session
    WHERE TRUE ${where.sql}
`;

export const turnPageQuery = (filters: TurnFilters, offset: number, limit: number): Clause => {
    const where = turnWhere(filters);
    return {
        sql: `SELECT turn_id, session_id, project, source, cwd, role, ts, text_excerpt
              FROM (${turnMatchesSql(where)}) matches
              WHERE score IS NOT NULL
              ORDER BY ts DESC
              LIMIT ? OFFSET ?`,
        params: [filters.q, ...where.params, limit, offset],
    };
};

export const turnCountQuery = (filters: TurnFilters): Clause => {
    const where = turnWhere(filters);
    return {
        sql: `SELECT count(*) AS total FROM (${turnMatchesSql(where)}) matches WHERE score IS NOT NULL`,
        params: [filters.q, ...where.params],
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

/** Projects by session count. */
export const projectPickerQuery = (): Clause => ({
    sql: `SELECT project AS value, count(*) AS uses
          FROM session
          WHERE project IS NOT NULL AND project <> ''
          GROUP BY project
          ORDER BY uses DESC
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
          ORDER BY uses DESC
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
        ${matchBm25Sql(COMMIT_FTS, "c")} AS score
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
