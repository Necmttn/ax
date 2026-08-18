#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { DuckDb, DuckDbLayer } from "@ax/lib/duckdb/internal";
import { Effect } from "effect";

const dylibPath = process.argv[2];
if (!dylibPath || !existsSync(dylibPath)) {
    console.error("usage: bun scripts/smoke-duckdb-dylib.ts <libduckdb.dylib|libduckdb.so>");
    process.exit(2);
}

/**
 * Air-gap smoke: open the given dylib through the production `DuckDb`
 * service (not a spike-only FFI copy) and prove the statically-linked FTS +
 * JSON extensions are actually reachable with no network/registry access
 * (`autoinstall_known_extensions=false`, `autoload_known_extensions=false`,
 * `custom_extension_repository=''`).
 */
const program = Effect.gen(function* () {
    const db = yield* DuckDb;
    yield* Effect.scoped(
        Effect.gen(function* () {
            const conn = yield* db.scoped(":memory:");
            yield* conn.exec("SET autoinstall_known_extensions=false");
            yield* conn.exec("SET autoload_known_extensions=false");
            yield* conn.exec("SET custom_extension_repository=''");
            yield* conn.exec("LOAD fts");
            yield* conn.exec("LOAD json");
            yield* conn.exec("CREATE TABLE documents (id INTEGER, body VARCHAR)");
            yield* conn.exec(
                "INSERT INTO documents VALUES (1, 'hello static world'), (2, 'unrelated text')",
            );
            yield* conn.exec("PRAGMA create_fts_index('documents', 'id', 'body', overwrite=1)");

            const ftsResult = yield* conn.query(
                "SELECT body FROM documents " +
                    "WHERE fts_main_documents.match_bm25(id, 'static') IS NOT NULL",
            );
            const jsonResult = yield* conn.query(
                "SELECT json_extract('{\"answer\":42}', '$.answer')::VARCHAR AS answer",
            );

            const fts = String(ftsResult.rows[0]?.body ?? "");
            const json = String(jsonResult.rows[0]?.answer ?? "");
            if (fts !== "hello static world") {
                return yield* Effect.die(new Error(`unexpected FTS result: ${fts}`));
            }
            if (json !== "42") {
                return yield* Effect.die(new Error(`unexpected JSON result: ${json}`));
            }

            console.log(`fts=${fts}`);
            console.log(`json=${json}`);
            console.log("DuckDB dynamic library air-gap smoke passed");
        }),
    );
});

Effect.runPromise(Effect.provide(program, DuckDbLayer(dylibPath))).catch((err) => {
    console.error(err);
    process.exit(1);
});
