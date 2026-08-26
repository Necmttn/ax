/**
 * Source-aware "is this a genuine typed user turn, or harness-injected
 * wrapper text" compatibility filter - extracted out of `queries/prompts.ts`
 * (#1095) so every surface that ranks or filters user turns shares ONE
 * definition instead of re-deriving it.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS GENERATED, NOT HAND-WRITTEN. See
 * `legacyInjectionClause` below - the short version is that `message_kind` is
 * stamped at INGEST, so a row written before the classifier learned a wrapper
 * shape keeps the stale kind forever unless the file is re-parsed. A read
 * command may not assume that has happened. Deriving the filter FROM
 * `FULL_CONTEXT_RULES` / `PI_CONTEXT_RULES` (`ingest/normalized/message-kind.ts`)
 * means a rule added to the classifier hardens every read surface below in the
 * same edit - there is no second list to keep in sync.
 *
 * WHY THE SQL EXPRESSIONS ARE CONFIGURABLE. Each caller joins `turn`/`session`
 * under different aliases (`t`/`s` in most places, `t2`/`s2` inside a
 * correlated subquery in `dashboard/sessions-query.ts`), and not every caller
 * has already restricted itself to `role = 'user'` before this filter runs
 * (`ax recall` searches both roles in one statement). Rather than one filter
 * per caller, the column names and the user-role guard are parameters.
 */
import {
    FULL_CONTEXT_RULES,
    PI_CONTEXT_RULES,
    type UserTextRules,
} from "../ingest/normalized/message-kind.ts";
import { NO_CLAUSE, type Clause } from "@ax/lib/duckdb/clause";

/**
 * Escape the LIKE metacharacters in a literal prefix.
 *
 * Necessary, not decorative: `<recommended_plugins>` contains `_`, which LIKE
 * reads as "any single character". Unescaped it would also exclude a human
 * prompt that happened to differ in that position - a silent over-filter, which
 * is the failure shape this whole module is about.
 */
export const escapeLike = (literal: string): string =>
    literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * A read-time repeat of the classifier's rules, DERIVED FROM THE SAME TABLES.
 *
 * `textExpr` lets a caller point the filter at whichever column carries the
 * full turn text under its own aliasing (`t.text` is the default and covers
 * every current caller).
 *
 * This clause becomes redundant once every row has been re-parsed. It is cheap,
 * it is generated, and "redundant" is the correct end state - do not delete it
 * on the strength of one machine's store being current.
 */
export const legacyInjectionClause = (
    rules: UserTextRules,
    textExpr = "t.text",
): Clause => {
    // `control` is included: an interrupt marker is not a typed request either.
    const prefixes = [...rules.control, ...rules.contextStartsWith];
    const parts: string[] = [];
    const params: (string | number)[] = [];

    for (const prefix of prefixes) {
        parts.push(`AND ${textExpr} NOT LIKE ? ESCAPE '\\'`);
        params.push(`${escapeLike(prefix)}%`);
    }
    for (const needle of rules.contextIncludes) {
        parts.push(`AND ${textExpr} NOT LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(needle)}%`);
    }
    for (const marker of rules.attachmentMarkers) {
        // The marker-only test, in SQL: strip every marker and require something
        // to be left. Mirrors `isOnlyAttachmentMarkers`, from the same RegExp.
        parts.push(
            `AND trim(regexp_replace(replace(${textExpr}, chr(10), ' '), ?, '', 'g')) <> ''`,
        );
        params.push(marker.source);
    }

    return parts.length === 0 ? NO_CLAUSE : { sql: parts.join(" "), params };
};

export interface UserTurnCompatExprs {
    /** SQL expression for the turn's full text column. Default `t.text`. */
    readonly textExpr?: string;
    /** SQL expression for the owning session's `source` column. Default `s.source`. */
    readonly sourceExpr?: string;
    /**
     * SQL expression for the turn's `role` column. When given, the whole
     * predicate is guarded so it only constrains USER rows -
     * `(roleExpr <> 'user' OR <source-aware filter>)` - so non-user rows (e.g.
     * assistant hits in `ax recall`) are always kept. Omit when the caller has
     * already restricted the surrounding query to `role = 'user'`.
     */
    readonly roleExpr?: string;
}

/**
 * The boolean predicate itself (no leading `AND`, no role guard) - for callers
 * that need to embed it inside a larger expression, e.g. an `ORDER BY` CASE
 * that DEPRIORITIZES a stale wrapper turn rather than excluding it outright
 * (`dashboard/sessions-query.ts`'s "first user message" ranking).
 *
 * Apply the legacy classifier guard only to sources that use that classifier.
 * The normalized ingest parsers use FULL_CONTEXT_RULES for Claude and Codex,
 * PI_CONTEXT_RULES for Pi and Omp, and no context classifier for other
 * sources. Keep that source split here so a prefix measured for one harness
 * cannot remove a real prompt from another harness. Unknown sources stay
 * unfiltered as well.
 */
export const userTurnCompatPredicate = (exprs: UserTurnCompatExprs = {}): Clause => {
    const textExpr = exprs.textExpr ?? "t.text";
    const sourceExpr = exprs.sourceExpr ?? "s.source";
    const full = legacyInjectionClause(FULL_CONTEXT_RULES, textExpr);
    const pi = legacyInjectionClause(PI_CONTEXT_RULES, textExpr);
    const fullBody = full.sql.slice("AND ".length);
    const piBody = pi.sql.slice("AND ".length);

    return {
        sql:
            `(${sourceExpr} NOT IN ('claude', 'codex', 'pi', 'omp')` +
            ` OR (${sourceExpr} IN ('claude', 'codex') AND ${fullBody})` +
            ` OR (${sourceExpr} IN ('pi', 'omp') AND ${piBody}))`,
        params: [...full.params, ...pi.params],
    };
};

/**
 * `userTurnCompatPredicate`, ready to append to a `WHERE` clause built from
 * `andAll(...)` (leading `AND`, optionally guarded by `roleExpr`).
 */
export const userTurnCompatClause = (exprs: UserTurnCompatExprs = {}): Clause => {
    const predicate = userTurnCompatPredicate(exprs);
    return {
        sql: exprs.roleExpr
            ? `AND (${exprs.roleExpr} <> 'user' OR ${predicate.sql})`
            : `AND ${predicate.sql}`,
        params: predicate.params,
    };
};
