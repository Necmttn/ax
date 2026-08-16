// packages/lib/src/sqlite/statement.ts
/**
 * "Is this string ONE statement?" - the check that keeps a silent half-write out
 * of the durable store.
 *
 * WHY THIS EXISTS. The seam runs a statement through `bun:sqlite`'s
 * `db.query(sql)`, which prepares with `sqlite3_prepare_v2`. That call compiles
 * the FIRST statement in the text and hands back a tail pointer for the rest;
 * the prepared-statement API then simply ignores the tail. So
 *
 *     exec("DELETE FROM plays_role WHERE ...; INSERT INTO plays_role ...")
 *
 * deletes the row, never inserts the replacement, reports `changes` for the
 * delete alone, and SUCCEEDS. Nothing anywhere says the second half was dropped.
 * On a rebuildable cache that is a bad afternoon; on the judgment sidecar it is a
 * decision the user made and can never get back.
 *
 * The layer's `schemaSql` is the one place that legitimately carries many
 * statements, and it does NOT come through here: it runs on `database.exec`,
 * which loops over the whole text by design (see the open path in ./sidecar.ts).
 *
 * WHY A SCANNER AND NOT `sql.includes(";")`. A semicolon is ordinary text inside
 * a string literal, a quoted identifier, or a comment. `WHERE rationale = 'a; b'`
 * is one statement, and refusing it would push callers into hand-rolled
 * concatenation - the exact thing the seam's bound parameters exist to stop. So
 * this walks the string, tracking the four SQLite quoting forms and both comment
 * forms, and reports only a separator that has executable text after it. A
 * TRAILING semicolon is fine, because nothing is lost to it.
 *
 * Pure, dependency-free and exhaustively tested next door: the interesting logic
 * is a string walk, and it should be checkable without opening a database.
 */

/** Where a second statement begins, and what it looks like. */
export interface ExtraStatement {
    /** Index of the `;` that separates the statements. */
    readonly separatorIndex: number;
    /** Index of the first executable character AFTER that separator. */
    readonly startIndex: number;
    /** Short excerpt of the text that `sqlite3_prepare_v2` would drop. */
    readonly excerpt: string;
}

const EXCERPT_LEN = 80;

const excerptOf = (text: string): string =>
    text.length > EXCERPT_LEN ? `${text.slice(0, EXCERPT_LEN)}…` : text;

const isSpace = (char: string): boolean =>
    char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";

/**
 * Index just past a quoted run that starts at `start`.
 *
 * SQLite doubles the quote to escape it (`'it''s'`), and has no backslash escape,
 * so a doubled quote continues the run rather than ending it. An UNTERMINATED run
 * swallows the remainder: the text is not valid SQL either way, and treating the
 * tail as literal means this function never invents a separator inside it.
 */
const skipQuoted = (sql: string, start: number, quote: string): number => {
    let i = start + 1;
    while (i < sql.length) {
        if (sql[i] === quote) {
            if (sql[i + 1] === quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    return sql.length;
};

/** Index of the next character that is neither whitespace nor a comment, or -1
 *  when only whitespace and comments remain. An unterminated comment returns -1
 *  for the same reason: SQLite would execute nothing after it. */
const nextExecutable = (sql: string, from: number): number => {
    let i = from;
    while (i < sql.length) {
        const char = sql[i]!;
        if (isSpace(char)) {
            i += 1;
            continue;
        }
        if (char === "-" && sql[i + 1] === "-") {
            const newline = sql.indexOf("\n", i);
            if (newline === -1) return -1;
            i = newline + 1;
            continue;
        }
        if (char === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            if (end === -1) return -1;
            i = end + 2;
            continue;
        }
        return i;
    }
    return -1;
};

/**
 * The second statement in `sql`, or `null` when there is only one.
 *
 * Handles all four SQLite quoting forms (`'text'`, `"identifier"`, `` `identifier` ``,
 * `[identifier]`) and both comment forms, so a semicolon inside any of them is
 * text rather than a separator.
 */
export const findExtraStatement = (sql: string): ExtraStatement | null => {
    let i = 0;
    while (i < sql.length) {
        const char = sql[i]!;
        if (char === "'" || char === '"' || char === "`") {
            i = skipQuoted(sql, i, char);
            continue;
        }
        if (char === "[") {
            // Bracket identifiers have no escape form in SQLite - the first `]`
            // ends the run.
            const end = sql.indexOf("]", i + 1);
            i = end === -1 ? sql.length : end + 1;
            continue;
        }
        if (char === "-" && sql[i + 1] === "-") {
            const newline = sql.indexOf("\n", i);
            i = newline === -1 ? sql.length : newline + 1;
            continue;
        }
        if (char === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            i = end === -1 ? sql.length : end + 2;
            continue;
        }
        if (char === ";") {
            const start = nextExecutable(sql, i + 1);
            if (start === -1) return null;
            return { separatorIndex: i, startIndex: start, excerpt: excerptOf(sql.slice(start)) };
        }
        i += 1;
    }
    return null;
};

/** True when `sql` carries exactly one statement (a trailing `;` is still one). */
export const isSingleStatement = (sql: string): boolean => findExtraStatement(sql) === null;
