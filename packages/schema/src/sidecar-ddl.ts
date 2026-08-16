// packages/schema/src/sidecar-ddl.ts
/** The judgment sidecar's DDL text, and the ONLY regex that reads it.
 *  Mirrors duckdb-ddl.ts for the cache half. */
import SIDECAR_SCHEMA_SQL_TEXT from "./schema.sidecar.sql" with { type: "text" };

export const SIDECAR_SCHEMA_SQL: string = SIDECAR_SCHEMA_SQL_TEXT;

const stripQuotes = (name: string): string => name.replace(/^"|"$/g, "");

/** Table names this DDL creates, in declaration order. */
export function parseSqliteTables(sql: string = SIDECAR_SCHEMA_SQL): readonly string[] {
    return [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS\s+("?[A-Za-z_][\w]*"?)\s*\(/gm)].map((m) =>
        stripQuotes(m[1]!),
    );
}

export interface SqliteColumnDef {
    readonly name: string;
    readonly type: string;
    readonly notNull: boolean;
}

/** Raw, comment-stripped column lines of one CREATE TABLE body. Same single-parse
 *  discipline as duckdb-ddl.ts: one extractor, so two readers cannot diverge. */
function sqliteTableBodyLines(table: string, sql: string): readonly string[] {
    const re = new RegExp(`^CREATE TABLE IF NOT EXISTS\\s+"?${table}"?\\s*\\(([\\s\\S]*?)^\\);`, "m");
    const body = re.exec(sql)?.[1];
    if (body === undefined) return [];
    return body
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter((line) => line.length > 0);
}

/** Column definitions (name, type, NOT NULL) of one CREATE TABLE body. */
export function parseSqliteColumnDefs(
    table: string,
    sql: string = SIDECAR_SCHEMA_SQL,
): readonly SqliteColumnDef[] {
    return sqliteTableBodyLines(table, sql)
        .map((line) => {
            const parts = line.split(/\s+/);
            const name = stripQuotes(parts[0]!);
            const type = (parts[1] ?? "").replace(/,$/, "");
            const notNull = /\bNOT NULL\b/.test(line);
            return { name, type, notNull };
        })
        .filter((col) => col.name.length > 0 && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK)$/i.test(col.name));
}

/** Column names of one CREATE TABLE body, in declaration order. */
export function parseSqliteColumns(table: string, sql: string = SIDECAR_SCHEMA_SQL): readonly string[] {
    return parseSqliteColumnDefs(table, sql).map((col) => col.name);
}
