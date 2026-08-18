/**
 * Derive `COMMENT ON` statements from the DDL's own `--` comments, so the
 * store documents itself (#869).
 *
 * The prose already lives in `schema.duckdb.sql` - table blocks above each
 * `CREATE TABLE`, column notes inline after the column definition. This module
 * turns that single source into catalog comments an agent can read back with
 * `duckdb_columns()` / `duckdb_tables()`, instead of trusting a snapshot doc
 * that drifts (prior art: alfredvc/cct, which comments every column for
 * exactly this reason). Applied with the schema self-heal in `seam.ts`, right
 * after the DDL itself - `COMMENT ON` is idempotent (last write wins), so
 * re-applying is safe.
 *
 * Parsing rules, deliberately dumb (the DDL is ours and regular):
 *  - A table's comment is the contiguous `--` block on the lines immediately
 *    above its `CREATE TABLE`. Pure banner lines (`-- ----`, `-- ====`) are
 *    dropped; `==== title ====` section headers keep their title text.
 *  - A column's comment is the inline `-- ...` after its definition, plus any
 *    standalone `--` lines directly above it INSIDE the block (continuation
 *    prose), joined in reading order.
 *  - `-- JSON` / `-- ref -> x` style one-liners are kept verbatim: terse, but
 *    exactly what an agent needs to know how to join or decode.
 */

export interface TableComments {
    readonly table: string;
    /** Joined table-block prose; null when the DDL has none (gated in tests). */
    readonly comment: string | null;
    /** column name -> joined comment; only columns that have one. */
    readonly columns: ReadonlyMap<string, string>;
}

/** A `--` line that is only decoration (rules of dashes/equals). */
const isBannerLine = (line: string): boolean => /^--\s*[-=\s]*$/.test(line);

/** Strip `-- ` prefix and any `==== ... ====` decoration, keep the words. */
const commentText = (line: string): string =>
    line
        .replace(/^--\s?/, "")
        .replace(/^=+\s*/, "")
        .replace(/\s*=+$/, "")
        .trim();

const joinProse = (lines: ReadonlyArray<string>): string | null => {
    const parts = lines.filter((l) => !isBannerLine(l)).map(commentText).filter((t) => t.length > 0);
    if (parts.length === 0) return null;
    return parts.join(" ");
};

const CREATE_RE = /^CREATE TABLE IF NOT EXISTS "?(\w+)"? \($/;
const COLUMN_RE = /^\s+(\w+)\s+[A-Z]/;

/** Parse the DDL into per-table comment structures. Exported for the coverage
 *  gate in `packages/schema`; runtime callers want {@link schemaCommentStatements}. */
export const parseSchemaComments = (ddl: string): ReadonlyArray<TableComments> => {
    const lines = ddl.split("\n");
    const tables: TableComments[] = [];
    for (let i = 0; i < lines.length; i++) {
        const create = CREATE_RE.exec(lines[i]!);
        if (create === null) continue;
        // Table block: walk contiguous `--` lines directly above.
        let j = i - 1;
        while (j >= 0 && lines[j]!.startsWith("--")) j--;
        const comment = joinProse(lines.slice(j + 1, i));
        // Columns: scan the block to the closing `);`.
        const columns = new Map<string, string>();
        let pending: string[] = [];
        for (let k = i + 1; k < lines.length; k++) {
            const line = lines[k]!;
            if (line.startsWith(");")) break;
            const trimmed = line.trim();
            if (trimmed.startsWith("--")) {
                pending.push(trimmed);
                continue;
            }
            const col = COLUMN_RE.exec(line);
            if (col === null) {
                pending = [];
                continue;
            }
            const inlineAt = line.indexOf("--");
            const inline = inlineAt >= 0 ? [line.slice(inlineAt)] : [];
            const prose = joinProse([...pending, ...inline]);
            pending = [];
            if (prose !== null) columns.set(col[1]!, prose);
        }
        tables.push({ table: create[1]!, comment, columns });
    }
    return tables;
};

const sqlString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * The full idempotent `COMMENT ON` script for a DDL string. One statement per
 * commented table/column; tables without prose emit nothing (the coverage test
 * in packages/schema is what drives that number to zero).
 */
export const schemaCommentStatements = (ddl: string): string => {
    const statements: string[] = [];
    for (const t of parseSchemaComments(ddl)) {
        // Identifiers always double-quoted: `commit` is a reserved word and
        // more may join it; quoting everything is uniformly valid.
        if (t.comment !== null) {
            statements.push(`COMMENT ON TABLE "${t.table}" IS ${sqlString(t.comment)};`);
        }
        for (const [column, comment] of t.columns) {
            statements.push(`COMMENT ON COLUMN "${t.table}"."${column}" IS ${sqlString(comment)};`);
        }
    }
    return statements.join("\n");
};
