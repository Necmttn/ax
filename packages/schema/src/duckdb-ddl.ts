// packages/schema/src/duckdb-ddl.ts
/** Parse helpers over schema.duckdb.sql. The ONLY place a regex touches the DDL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

export const DUCKDB_SCHEMA_PATH = join(HERE, "schema.duckdb.sql");
export const SURREAL_SCHEMA_PATH = join(HERE, "schema.surql");

export const DUCKDB_SCHEMA_SQL: string = readFileSync(DUCKDB_SCHEMA_PATH, "utf8");

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
}

export function parseDuckdbIndexes(sql: string = DUCKDB_SCHEMA_SQL): readonly DuckdbIndex[] {
    const re = /^CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+("?[\w]+"?)\s+ON\s+("?[\w]+"?)\s*\(/gm;
    return [...sql.matchAll(re)].map((m) => ({
        name: stripQuotes(m[2]!),
        table: stripQuotes(m[3]!),
        unique: m[1] !== undefined,
    }));
}

/** Columns of one CREATE TABLE body, in declaration order. */
export function parseDuckdbColumns(table: string, sql: string = DUCKDB_SCHEMA_SQL): readonly string[] {
    const re = new RegExp(`^CREATE TABLE IF NOT EXISTS\\s+"?${table}"?\\s*\\(([\\s\\S]*?)^\\);`, "m");
    const body = sql.match(re)?.[1];
    if (body === undefined) return [];
    return body
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter((line) => line.length > 0)
        .map((line) => stripQuotes(line.split(/\s+/)[0]!))
        .filter((name) => name.length > 0 && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK)$/i.test(name));
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
