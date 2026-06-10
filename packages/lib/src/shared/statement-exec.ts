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

import { Array as Arr, Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import type { DbError } from "../errors.ts";

/** Default statements per `db.query()` call. Matches the long-standing
 *  evidence-writers value; safely under SurrealDB's parser limits. */
export const DEFAULT_CHUNK_SIZE = 250;

export interface ExecuteOptions {
    /** Statements per `db.query()` call. Defaults to {@link DEFAULT_CHUNK_SIZE}. */
    readonly chunkSize?: number;
    /** Span label identifying the caller (e.g. "upsertTurns") so DB time is
     *  attributable per write-helper in a trace viewer. Default "statements". */
    readonly label?: string;
}

/** Execute pre-built statements against an already-resolved client. Use when
 *  the caller already holds a `SurrealClientShape` (e.g. inside a larger
 *  `Effect.gen` that resolved `SurrealClient` once). */
export const executeStatementsWith = (
    db: SurrealClientShape,
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError> => {
    if (statements.length === 0) return Effect.void;
    const chunks = Arr.chunksOf(statements, options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    return Effect.forEach(
        chunks,
        (chunk, i) =>
            db.query(chunk.join("")).pipe(
                Effect.asVoid,
                Effect.withSpan("db.chunk", {
                    attributes: { "db.chunk.index": i, "db.chunk.statements": chunk.length },
                }),
            ),
        { discard: true },
    ).pipe(
        Effect.withSpan(`db.exec:${options?.label ?? "statements"}`, {
            attributes: {
                "db.exec.statements": statements.length,
                "db.exec.chunks": chunks.length,
            },
        }),
    );
};

/** Execute pre-built statements, resolving `SurrealClient` from context. */
export const executeStatements = (
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, statements, options);
    });
