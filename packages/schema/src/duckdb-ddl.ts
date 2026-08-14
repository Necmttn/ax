// packages/schema/src/duckdb-ddl.ts
/** Parse helpers over schema.duckdb.sql. The ONLY place a regex touches the DDL. */
import DUCKDB_SCHEMA_SQL_TEXT from "./schema.duckdb.sql" with { type: "text" };

export const DUCKDB_SCHEMA_SQL: string = DUCKDB_SCHEMA_SQL_TEXT;

const stripQuotes = (name: string): string => name.replace(/^"|"$/g, "");

export function parseDuckdbTables(sql: string = DUCKDB_SCHEMA_SQL): readonly string[] {
    return [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS\s+("?[A-Za-z_][\w]*"?)\s*\(/gm)].map((m) =>
        stripQuotes(m[1]!),
    );
}

export interface DuckdbIndex {
    readonly name: string;
    readonly table: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
}

export function parseDuckdbIndexes(sql: string = DUCKDB_SCHEMA_SQL): readonly DuckdbIndex[] {
    const re = /^CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+("?[\w]+"?)\s+ON\s+("?[\w]+"?)\s*\(([^)]*)\)/gm;
    return [...sql.matchAll(re)].map((m) => ({
        name: stripQuotes(m[2]!),
        table: stripQuotes(m[3]!),
        unique: m[1] !== undefined,
        columns: m[4]!.split(",").map((c) => stripQuotes(c.trim())),
    }));
}

/** Raw, comment-stripped, blank-filtered column-definition lines of one CREATE
 *  TABLE body, in declaration order. The one place both `parseDuckdbColumns`
 *  and `parseDuckdbColumnDefs` extract a table body and split it into lines -
 *  keeping this logic in a single helper is what the P3-1 standards finding
 *  asked for (two independent regex-driven parsers of the same table body can
 *  silently diverge on a DDL format change; one parser cannot). */
function duckdbTableBodyLines(table: string, sql: string): readonly string[] {
    const re = new RegExp(`^CREATE TABLE IF NOT EXISTS\\s+"?${table}"?\\s*\\(([\\s\\S]*?)^\\);`, "m");
    const body = re.exec(sql)?.[1];
    if (body === undefined) return [];
    return body
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter((line) => line.length > 0);
}

/** Columns of one CREATE TABLE body, in declaration order. */
export function parseDuckdbColumns(table: string, sql: string = DUCKDB_SCHEMA_SQL): readonly string[] {
    return parseDuckdbColumnDefs(table, sql).map((col) => col.name);
}

export interface DuckdbColumnDef {
    readonly name: string;
    readonly type: string;
    readonly notNull: boolean;
}

/** Column definitions (name, type, NOT NULL) of one CREATE TABLE body, in declaration order. */
export function parseDuckdbColumnDefs(table: string, sql: string = DUCKDB_SCHEMA_SQL): readonly DuckdbColumnDef[] {
    return duckdbTableBodyLines(table, sql)
        .map((line) => {
            const parts = line.split(/\s+/);
            const name = stripQuotes(parts[0]!);
            const type = (parts[1] ?? "").replace(/,$/, "");
            const notNull = /\bNOT NULL\b/.test(line);
            return { name, type, notNull };
        })
        .filter((col) => col.name.length > 0 && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK)$/i.test(col.name));
}

export interface SurrealTable {
    readonly table: string;
    readonly relation: boolean;
}

export function parseSurrealTables(surql: string): readonly SurrealTable[] {
    const re = /^DEFINE TABLE (?:IF NOT EXISTS )?([\w]+)([^;]*);/gm;
    return [...surql.matchAll(re)].map((m) => ({
        table: m[1]!,
        relation: /TYPE RELATION/.test(m[2] ?? ""),
    }));
}
