/**
 * Full-text search: built at ingest, queried through `match_bm25`.
 *
 * WHY IT IS NOT IN THE DDL. DuckDB's `fts` extension does not declare an index -
 * `PRAGMA create_fts_index` MATERIALIZES a schema of tables (`fts_main_<table>`)
 * from the CURRENT CONTENTS of the source table. So it is not a schema statement
 * that can live in schema.duckdb.sql; it is a build step that has to run AFTER
 * the rows land, on every ingest, which is what {@link buildFtsIndexes} is.
 *
 * WHAT IS COVERED, and why so little. `turn.text_excerpt` and `commit.message` -
 * that is the whole set, and it is exactly what `ax recall` searches. The Surreal
 * schema also had an ngram FTS index over skill name/description; issue #758
 * dropped it deliberately, because the skill catalogue is small enough that a
 * plain `ILIKE` scan beats an index that cost more to build than the scan it
 * replaced. Content-block search is not carried over either.
 *
 * `LOAD fts`, never `INSTALL fts`. The dylib ax ships links fts statically
 * (scripts/build-duckdb.sh, `CORE_EXTENSIONS='json'` plus the local fts config),
 * and that script's air-gap smoke proves `LOAD fts` works with
 * `autoinstall_known_extensions=false`, `autoload_known_extensions=false` and no
 * network. Issuing `INSTALL` would reach for the extension repository - a network
 * call on a load-bearing local path, which is exactly what the static build was
 * built to avoid.
 */
import { Effect } from "effect";
import type { CacheWriteError, CacheWriteService } from "./seam.ts";

export interface FtsTarget {
    readonly table: string;
    /** The table's primary key column - what `match_bm25` scores against. */
    readonly idColumn: string;
    /** The single text column indexed. */
    readonly textColumn: string;
}

/**
 * The WHOLE covered set. Adding to it is a real decision, not a config tweak:
 * every target costs a full index rebuild on every ingest.
 */
export const FTS_TARGETS: ReadonlyArray<FtsTarget> = [
    { table: "turn", idColumn: "id", textColumn: "text_excerpt" },
    { table: "commit", idColumn: "id", textColumn: "message" },
];

/** The generated index schema for a target - `fts_main_turn`, `fts_main_commit`. */
export const ftsSchemaName = (target: FtsTarget): string => `fts_main_${target.table}`;

/**
 * The scoring expression a reader selects: non-NULL when the row matches, NULL
 * when it does not - so `WHERE <this> IS NOT NULL` is the filter and
 * `ORDER BY <this> DESC` is the ranking. `alias` is the source table's alias in
 * the reader's own FROM clause.
 *
 * The query text is a BOUND parameter (`?`), never interpolated - the whole
 * reason the Surreal path had to inline record literals is gone in DuckDB.
 */
export const matchBm25Sql = (target: FtsTarget, alias: string): string =>
    `${ftsSchemaName(target)}.match_bm25(${alias}.${target.idColumn}, ?)`;

/**
 * (Re)build every FTS index. Idempotent: `overwrite = 1` replaces an existing
 * index, so this is safe to run at the end of every ingest, and it MUST run
 * there - the index is a materialized copy, so rows added since the last build
 * are invisible to search until it does.
 *
 * The PRAGMA takes its arguments as string literals rather than parameters, so
 * every value here comes from {@link FTS_TARGETS} - a module constant, never
 * caller input. `buildFtsIndexes` accepts a `targets` override for tests only;
 * it validates identifiers rather than trusting them.
 */
export const buildFtsIndexes = (
    write: CacheWriteService,
    targets: ReadonlyArray<FtsTarget> = FTS_TARGETS,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        if (targets.length === 0) return;
        yield* write.exec("LOAD fts");
        for (const target of targets) {
            for (const name of [target.table, target.idColumn, target.textColumn]) {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                    return yield* Effect.die(
                        new Error(`fts: refusing to build an index for the unsafe identifier ${JSON.stringify(name)}`),
                    );
                }
            }
            yield* write.exec(
                `PRAGMA create_fts_index('${target.table}', '${target.idColumn}', '${target.textColumn}', overwrite = 1)`,
            );
        }
    });
