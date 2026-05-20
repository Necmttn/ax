/**
 * statement-exec: the shared seam for executing a batch of SurrealQL
 * statements. Statements are joined and sent in chunks because a single
 * `db.query()` with thousands of statements blows past SurrealDB's parser
 * limits and balloons memory.
 *
 * This is the EXECUTE counterpart to `surql.ts` (which formats literals) and
 * `graph-query.ts` (which runs typed reads). Every ingest stage that builds
 * `UPSERT`/`RELATE`/`CREATE` statement arrays routes them through here, so
 * chunking + concurrency policy lives in exactly one place.
 */

import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import type { DbError } from "../errors.ts";

/** Default statements per `db.query()` call. Matches the long-standing
 *  evidence-writers value; safely under SurrealDB's parser limits. */
export const DEFAULT_CHUNK_SIZE = 250;

export interface ExecuteOptions {
    /** Statements per `db.query()` call. Defaults to {@link DEFAULT_CHUNK_SIZE}. */
    readonly chunkSize?: number;
}

/** Execute pre-built statements against an already-resolved client. Use when
 *  the caller already holds a `SurrealClientShape` (e.g. inside a larger
 *  `Effect.gen` that resolved `SurrealClient` once). */
export const executeStatementsWith = (
    db: SurrealClientShape,
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        if (statements.length === 0) return;
        const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
        for (let i = 0; i < statements.length; i += chunkSize) {
            yield* db.query(statements.slice(i, i + chunkSize).join(""));
        }
    });

/** Execute pre-built statements, resolving `SurrealClient` from context. */
export const executeStatements = (
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, statements, options);
    });
