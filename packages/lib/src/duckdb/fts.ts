/**
 * Full-text search: built at ingest, queried through `match_bm25`.
 *
 * WHY IT IS NOT IN THE DDL. DuckDB's `fts` extension does not declare an index -
 * `PRAGMA create_fts_index` MATERIALIZES a schema of tables (`fts_main_<table>`)
 * from the CURRENT CONTENTS of the source table. So it is not a schema statement
 * that can live in schema.duckdb.sql; it is a build step that has to run AFTER
 * the rows land, on every ingest, which is what {@link buildFtsIndexes} is.
 *
 * WHAT IS COVERED, and why so little. `turn.text` (FULL turn text, #921) and
 * `commit.message` - that is the whole set, and it is exactly what `ax recall`
 * searches. Turn coverage was `text_excerpt` (the first 500 chars) until #921:
 * a phrase past the excerpt bound was silently unfindable, and the measured
 * cost of indexing full text on the real 1.05M-turn store was small (rebuild
 * 2.2s -> 6.2s, terms 3.2M -> 19.6M rows, no measurable file growth) - with
 * the #909 skip, a no-op ingest pays none of it. The Surreal schema also had
 * an ngram FTS index over skill name/description; issue #758 dropped it
 * deliberately, because the skill catalogue is small enough that a plain
 * `ILIKE` scan beats an index that cost more to build than the scan it
 * replaced. Content-block search is not carried over either.
 *
 * `LOAD fts`, never `INSTALL fts`. The dylib ax ships links fts statically
 * (scripts/build-duckdb.sh, `CORE_EXTENSIONS='json'` plus the local fts config),
 * and that script's air-gap smoke proves `LOAD fts` works with
 * `autoinstall_known_extensions=false`, `autoload_known_extensions=false` and no
 * network. Issuing `INSTALL` would reach for the extension repository - a network
 * call on a load-bearing local path, which is exactly what the static build was
 * built to avoid.
 *
 * SKIP-IF-UNCHANGED (#909). A full rebuild is `PRAGMA create_fts_index(...,
 * overwrite=1)` scanning the WHOLE source table, and it used to run
 * unconditionally at the tail of every ingest and every `withConfigWrite` call -
 * a large share of the warm-run tail once `turn` passed a million rows, almost
 * always for a table that had not changed since the last build. `fts_index_state`
 * (schema.duckdb.sql) stores one row per target: a content digest computed
 * ENTIRELY in SQL (never bring the underlying UBIGINT hash through JS - see
 * {@link ftsDigestSql}) plus when it was last built. Per target, {@link
 * buildFtsIndexes} now:
 *   1. computes the current digest;
 *   2. reads the stored digest;
 *   3. probes whether `fts_main_<table>` still exists (the fts extension
 *      materializes it as a real schema, so a prior rebuild can be undone by
 *      anything that drops it, or never happened on a store that only imported
 *      the bookkeeping row);
 *   4. rebuilds only when the digest moved OR the schema is missing, then
 *      records the new digest. A digest match with a MISSING schema still
 *      rebuilds - the bookkeeping row is not proof the index exists.
 * The digest string is prefixed with the formula version. Bumping it forces
 * exactly one rebuild fleet-wide the next time this ships, which is the escape
 * hatch if the formula ever needs to change.
 */
import { Effect, Option, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "./seam.ts";

export interface FtsTarget {
    readonly table: string;
    /** The table's primary key column - what `match_bm25` scores against. */
    readonly idColumn: string;
    /** The single text column indexed. */
    readonly textColumn: string;
}

/** The digest formula version - bump to force a one-time rebuild of every
 *  target. v3 hashes the id and text as ONE value per row (#948). The prior
 *  two-argument hash left the aggregate unchanged when text values moved
 *  between existing ids. */
const FTS_DIGEST_VERSION = "v3";

/**
 * A per-target content digest computed ENTIRELY in SQL as one VARCHAR. Never
 * decode the underlying `bit_xor(hash(...))` (a UBIGINT) in JS - the seam's
 * `write.raw` applies no column decoder, and a BIGINT arrives as a JS
 * `bigint` that silently fails a `typeof x === "number"` check (see
 * CLAUDE.md's raw-numeric-cast trap). Casting the whole expression to VARCHAR
 * in SQL sidesteps that entirely: this seam only ever sees a string.
 *
 * `bit_xor` is commutative/order-independent, so a row landing via any write
 * path (batch insert, spool flush, single put) produces the same digest.
 * Each row hashes one id-delimited-text value, so moving text between ids
 * changes the row hashes before the aggregate combines them.
 * `COALESCE(bit_xor(...), '0')` covers the empty-table case, where `bit_xor`
 * itself returns NULL.
 */
export const ftsDigestSql = (target: FtsTarget): string =>
    `SELECT '${FTS_DIGEST_VERSION}:' || count(*)::VARCHAR || ':' || ` +
    `COALESCE(bit_xor(hash(${target.idColumn} || chr(31) || COALESCE(${target.textColumn}, '')))::VARCHAR, '0') AS digest ` +
    `FROM "${target.table}"`;

/** Per-target rebuild outcome, returned so a caller (or a test) can observe
 *  whether a warm no-op run actually skipped the rebuild. */
export interface FtsBuildOutcome {
    readonly table: string;
    readonly rebuilt: boolean;
}

/** Full `turn.text` since #921 (was `text_excerpt` - see the module doc).
 *  Exported by name so readers (`ax recall`, loc-query) reference the SAME
 *  target the builder indexes instead of re-declaring it and drifting. */
export const TURN_FTS_TARGET: FtsTarget = { table: "turn", idColumn: "id", textColumn: "text" };
export const COMMIT_FTS_TARGET: FtsTarget = { table: "commit", idColumn: "id", textColumn: "message" };

/**
 * The WHOLE covered set. Adding to it is a real decision, not a config tweak:
 * every target costs a full index rebuild on every ingest where its digest moves.
 */
export const FTS_TARGETS: ReadonlyArray<FtsTarget> = [TURN_FTS_TARGET, COMMIT_FTS_TARGET];

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
 *
 * `conjunctive` (#1023): DuckDB's `match_bm25` defaults to `conjunctive := 0`,
 * an OR over the query's terms - so `"duckdb spool"` matches any row with
 * EITHER word, a huge pool for a multi-word query. `conjunctive: true` requires
 * every (stemmed) term present, which is what a multi-word query reads as.
 */
export const matchBm25Sql = (
    target: FtsTarget,
    alias: string,
    opts: { readonly conjunctive?: boolean } = {},
): string =>
    `${ftsSchemaName(target)}.match_bm25(${alias}.${target.idColumn}, ?${
        opts.conjunctive ? ", conjunctive := 1" : ""
    })`;

/**
 * (Re)build every FTS index THAT NEEDS IT. Idempotent: `overwrite = 1`
 * replaces an existing index, so this is safe to run at the end of every
 * ingest, and it MUST run there - the index is a materialized copy, so rows
 * added since the last build are invisible to search until it does. What
 * changed in #909 is that a target whose content digest still matches the
 * stored one, AND whose `fts_main_<table>` schema still exists, is skipped -
 * see the module doc for the exact rule.
 *
 * The PRAGMA takes its arguments as string literals rather than parameters, so
 * every value here comes from {@link FTS_TARGETS} - a module constant, never
 * caller input. `buildFtsIndexes` accepts a `targets` override for tests only;
 * it validates identifiers rather than trusting them.
 *
 * Returns one {@link FtsBuildOutcome} per target, in target order, so a caller
 * (or a test asserting a warm no-op run genuinely skipped) can observe what
 * happened without re-deriving it. `LOAD fts` runs at most once, and only when
 * at least one target actually needs a rebuild - a fully-skipped run touches
 * the fts extension not at all. Readers (`ax recall`, `match_bm25` callers)
 * autoload the extension in their OWN connection independently; this LOAD is
 * only for the `PRAGMA create_fts_index` call below, which is not autoloadable.
 */
export const buildFtsIndexes = (
    write: CacheWriteService,
    targets: ReadonlyArray<FtsTarget> = FTS_TARGETS,
): Effect.Effect<ReadonlyArray<FtsBuildOutcome>, CacheWriteError> =>
    Effect.gen(function* () {
        if (targets.length === 0) return [];
        for (const target of targets) {
            for (const name of [target.table, target.idColumn, target.textColumn]) {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                    return yield* Effect.die(
                        new Error(`fts: refusing to build an index for the unsafe identifier ${JSON.stringify(name)}`),
                    );
                }
            }
        }

        const digestSchema = Schema.Struct({ digest: Schema.String });
        const countSchema = Schema.Struct({ n: Schema.BigInt });

        const decisions: Array<{ readonly target: FtsTarget; readonly digest: string; readonly rebuild: boolean }> =
            [];
        for (const target of targets) {
            const currentRow = yield* write.first(digestSchema, ftsDigestSql(target));
            const currentDigest = Option.getOrElse(currentRow, () => ({ digest: `${FTS_DIGEST_VERSION}:0:0` })).digest;

            const storedRow = yield* write.first(
                digestSchema,
                "SELECT digest FROM fts_index_state WHERE id = ?",
                [target.table],
            );

            const schemaRow = yield* write.first(
                countSchema,
                "SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = ?",
                [ftsSchemaName(target)],
            );
            const schemaExists = Number(Option.getOrElse(schemaRow, () => ({ n: 0n })).n) > 0;

            const digestMatches = Option.isSome(storedRow) && storedRow.value.digest === currentDigest;
            decisions.push({ target, digest: currentDigest, rebuild: !(digestMatches && schemaExists) });
        }

        if (decisions.some((decision) => decision.rebuild)) {
            yield* write.exec("LOAD fts");
        }

        const outcomes: FtsBuildOutcome[] = [];
        for (const { target, digest, rebuild } of decisions) {
            if (!rebuild) {
                yield* Effect.logDebug(`fts: ${target.table} unchanged, skip rebuild`);
                outcomes.push({ table: target.table, rebuilt: false });
                continue;
            }
            yield* Effect.logInfo(`fts: rebuilding ${target.table}`);
            yield* write.exec(
                `PRAGMA create_fts_index('${target.table}', '${target.idColumn}', '${target.textColumn}', overwrite = 1)`,
            );
            yield* write.exec(
                "INSERT OR REPLACE INTO fts_index_state (id, digest, built_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                [target.table, digest],
            );
            outcomes.push({ table: target.table, rebuilt: true });
        }
        return outcomes;
    });
