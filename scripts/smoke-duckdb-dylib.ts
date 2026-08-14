#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { CString } from "bun:ffi";
import {
    DUCKDB_RESULT_SIZE,
    openDuckDB,
    ptr,
} from "./duckdb-spike/ffi/duckdb-ffi.ts";

const dylibPath = process.argv[2];
if (!dylibPath || !existsSync(dylibPath)) {
    console.error("usage: bun scripts/smoke-duckdb-dylib.ts <libduckdb.dylib|libduckdb.so>");
    process.exit(2);
}

const library = openDuckDB(dylibPath);
const { symbols } = library;
const databaseBuffer = new BigUint64Array(1);
const connectionBuffer = new BigUint64Array(1);
const databasePointer = ptr(databaseBuffer);
const connectionPointer = ptr(connectionBuffer);
let databaseOpen = false;
let connected = false;

function checkState(state: number, operation: string): void {
    if (state !== 0) throw new Error(`${operation} failed with duckdb_state=${state}`);
}

function query(sql: string): { result: ReturnType<typeof ptr>; buffer: Uint8Array } {
    const buffer = new Uint8Array(DUCKDB_RESULT_SIZE);
    const result = ptr(buffer);
    const state = symbols.duckdb_query(
        connectionBuffer[0],
        Buffer.from(`${sql}\0`),
        result,
    );
    if (state !== 0) {
        const errorPointer = symbols.duckdb_result_error(result);
        const message = errorPointer
            ? new CString(errorPointer as never).toString()
            : "unknown DuckDB error";
        symbols.duckdb_destroy_result(result);
        throw new Error(`${sql}\n${message}`);
    }
    return { result, buffer };
}

function execute(sql: string): void {
    const { result } = query(sql);
    symbols.duckdb_destroy_result(result);
}

function scalar(sql: string): string {
    const { result } = query(sql);
    try {
        if (symbols.duckdb_row_count(result) !== 1n) {
            throw new Error(`expected one row from: ${sql}`);
        }
        const valuePointer = symbols.duckdb_value_varchar(result, 0n, 0n);
        if (!valuePointer) throw new Error(`expected a value from: ${sql}`);
        try {
            return new CString(valuePointer as never).toString();
        } finally {
            symbols.duckdb_free(valuePointer);
        }
    } finally {
        symbols.duckdb_destroy_result(result);
    }
}

try {
    checkState(
        symbols.duckdb_open(Buffer.from(":memory:\0"), databasePointer),
        "duckdb_open",
    );
    databaseOpen = true;
    checkState(symbols.duckdb_connect(databaseBuffer[0], connectionPointer), "duckdb_connect");
    connected = true;

    execute("SET autoinstall_known_extensions=false");
    execute("SET autoload_known_extensions=false");
    execute("SET custom_extension_repository=''");
    execute("LOAD fts");
    execute("LOAD json");
    execute("CREATE TABLE documents (id INTEGER, body VARCHAR)");
    execute("INSERT INTO documents VALUES (1, 'hello static world'), (2, 'unrelated text')");
    execute("PRAGMA create_fts_index('documents', 'id', 'body', overwrite=1)");

    const fts = scalar(
        "SELECT body FROM documents " +
            "WHERE fts_main_documents.match_bm25(id, 'static') IS NOT NULL",
    );
    const json = scalar("SELECT json_extract('{\"answer\":42}', '$.answer')::VARCHAR");
    if (fts !== "hello static world") throw new Error(`unexpected FTS result: ${fts}`);
    if (json !== "42") throw new Error(`unexpected JSON result: ${json}`);

    console.log(`fts=${fts}`);
    console.log(`json=${json}`);
    console.log("DuckDB dynamic library air-gap smoke passed");
} finally {
    if (connected) symbols.duckdb_disconnect(connectionPointer);
    if (databaseOpen) symbols.duckdb_close(databasePointer);
    library.close();
}
