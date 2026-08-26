/**
 * `ax prompts` - the prompts YOU typed, across every harness ax ingests.
 *
 * WHY THIS IS NOT `ax recall`. `recall` is full-text search over everything
 * said in a session - assistant turns, subagent turns, commits, skills - and
 * answers "where was this discussed". This answers a different question: "what
 * did I ask for", browsable with NO query at all, deduped, newest first. That
 * makes it the reverse-history-search surface for an agent harness, the thing
 * Ctrl+R gives you in a shell and Claude Code's own Ctrl+R does badly (no
 * cross-session view, no multi-line handling).
 *
 * WHY IT IS SHORT. It is short because `turn.message_kind` now MEANS something.
 * The first working version of this lens lived outside ax as a shell script
 * carrying ~25 lines of `NOT LIKE` to strip `<task-notification>`,
 * `<recommended_plugins>`, bare `[Image: ...]` markers and friends out of the
 * `task` kind - 582 of 1,355 rows, 43%. That list belonged in the classifier,
 * and it is there now (`ingest/normalized/message-kind.ts`). If a machine-text
 * shape shows up in this command's output, the fix is a rule in that file, NOT
 * another predicate here. One place to be wrong is the whole design.
 *
 * TWO filters stay here on purpose, because neither is a message-KIND question:
 *   - `source NOT LIKE '%-subagent'`: a subagent's opening turn is a genuine
 *     task - a dispatch brief - but an AGENT wrote it. The kind is right; the
 *     author is not who this command is about.
 *   - dedupe by text: repeating a prompt is normal and the same line 12 times
 *     is not 12 answers. The repeat count is kept and reported.
 *
 * Deref-free single statement, `CacheRead` against the published snapshot.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheFirst, cacheRows } from "@ax/lib/duckdb/query";
import { andAll, NO_CLAUSE, withinDaysClause, type Clause } from "@ax/lib/duckdb/clause";
import {
    escapeLike,
    legacyInjectionClause,
    userTurnCompatClause,
} from "./user-turn-compat.ts";

export { escapeLike, legacyInjectionClause };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptRow {
    /** Session the most recent occurrence belongs to - the deeplink target. */
    readonly session: string;
    /** Harness label (`claude`, `codex`, `opencode`, ...). */
    readonly source: string;
    readonly cwd: string | null;
    /** ISO timestamp of the most recent time this prompt was typed. */
    readonly ts: string;
    readonly text: string;
    /** How many times this exact prompt was typed in the window (>= 1). */
    readonly repeats: number;
}

export interface PromptsResult {
    readonly since_days: number;
    /** The substring searched, or null when browsing. */
    readonly query: string | null;
    /** The cwd prefix rows were scoped to, or null for every project. */
    readonly scope: string | null;
    readonly rows: ReadonlyArray<PromptRow>;
    /** Distinct prompts matching before `limit` was applied. */
    readonly total: number;
    readonly limit: number;
}

export interface PromptsInput {
    readonly sinceDays: number;
    readonly limit: number;
    /** Case-insensitive substring; empty/undefined browses instead of searching. */
    readonly query?: string | undefined;
    /** Absolute path; matches that directory and everything under it. */
    readonly scope?: string | undefined;
}

export const PROMPTS_DEFAULT_WINDOW_DAYS = 90;
export const PROMPTS_DEFAULT_LIMIT = 40;

// ---------------------------------------------------------------------------
// Clause builders (pure, unit-tested without a DB)
// ---------------------------------------------------------------------------

/**
 * The predicate every prompt row must satisfy, shared by the row read and the
 * count. Kept as ONE builder so the count can never describe a different set
 * than the rows it is counting - a mismatch there would not error, it would
 * print "58 matches" above 12 unrelated lines.
 */
export const promptsWhere = (input: PromptsInput): Clause =>
    andAll([
        {
            // `message_kind = 'task'` is the load-bearing filter and it is the
            // classifier's job to make it true. See the module docstring.
            sql:
                "AND t.role = 'user' AND t.message_kind = 'task'" +
                // An agent wrote a subagent's dispatch brief; the kind is right,
                // the author is not the person running this command.
                " AND s.source NOT LIKE '%-subagent'" +
                " AND t.text IS NOT NULL AND length(trim(t.text)) > 1",
            params: [],
        },
        withinDaysClause("t.ts", input.sinceDays),
        userTurnCompatClause(),
        scopeClause(input.scope),
        queryClause(input.query),
    ]);

/**
 * Scope to a directory SUBTREE, not one exact path: agents run in worktrees
 * under the repo root, so an equality test on `cwd` silently hides most of a
 * project's own history.
 *
 * The `LIKE` pattern is a BOUND parameter, so a path containing `%` or `_`
 * matches more than it should but can never alter the statement. That trade is
 * accepted (a wildcard in a real project path is vanishingly rare, and the
 * over-match is visible in the output) where injection would not be.
 */
export const scopeClause = (scope: string | undefined): Clause => {
    const trimmed = scope?.trim();
    if (!trimmed) return NO_CLAUSE;
    const root = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
    return {
        sql: "AND (s.cwd = ? OR s.cwd LIKE ?)",
        params: [root, `${root}/%`],
    };
};

/**
 * Case-insensitive substring match on the FULL text, not the excerpt.
 *
 * The searched term is escaped (see {@link escapeLike}) before the wildcards
 * are wrapped around it: unescaped, a `%` or `_` typed by the user is read by
 * LIKE as a metacharacter rather than a literal, so `-q '100%'` over-matches
 * anything and `-q '_'` matches almost every row.
 */
export const queryClause = (query: string | undefined): Clause => {
    const trimmed = query?.trim();
    if (!trimmed) return NO_CLAUSE;
    return {
        sql: "AND lower(t.text) LIKE lower(?) ESCAPE '\\'",
        params: [`%${escapeLike(trimmed)}%`],
    };
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const RowSchema = Schema.Struct({
    session: Schema.String,
    source: Schema.String,
    cwd: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
    text: Schema.String,
    repeats: NumberFromBigIntColumn,
});

const CountSchema = Schema.Struct({ total: NumberFromBigIntColumn });

export const fetchPrompts = (
    input: PromptsInput,
): Effect.Effect<PromptsResult, never, import("@ax/lib/duckdb/seam").CacheRead> =>
    Effect.gen(function* () {
        const where = promptsWhere(input);

        // `repeats` counts every occurrence of the text; QUALIFY then keeps only
        // the newest row per text. Both window functions see the same frame, so
        // the count survives the dedupe - computing it after would always be 1.
        const rows = yield* cacheRows(
            RowSchema,
            {
                sql:
                    "SELECT t.session AS session, s.source AS source, s.cwd AS cwd," +
                    " t.ts AS ts, trim(t.text) AS text," +
                    " count(*) OVER (PARTITION BY trim(t.text)) AS repeats" +
                    " FROM turn t JOIN session s ON s.id = t.session" +
                    ` WHERE 1 = 1 ${where.sql}` +
                    " QUALIFY row_number() OVER (PARTITION BY trim(t.text) ORDER BY t.ts DESC) = 1" +
                    " ORDER BY t.ts DESC LIMIT ?",
                params: [...where.params, input.limit],
            },
            "prompts.rows",
        );

        const counted = yield* cacheFirst(
            CountSchema,
            {
                sql:
                    "SELECT count(DISTINCT trim(t.text)) AS total" +
                    " FROM turn t JOIN session s ON s.id = t.session" +
                    ` WHERE 1 = 1 ${where.sql}`,
                params: [...where.params],
            },
            "prompts.count",
        );

        return {
            since_days: input.sinceDays,
            query: input.query?.trim() || null,
            scope: input.scope?.trim() || null,
            rows: rows.map((r) => ({
                session: r.session,
                source: r.source,
                cwd: r.cwd,
                ts: r.ts.toISOString(),
                text: r.text,
                repeats: r.repeats,
            })),
            total: counted?.total ?? rows.length,
            limit: input.limit,
        };
    });
