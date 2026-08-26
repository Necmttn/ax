/**
 * `ax ingest repair-indexes` (#1084): rebuild secondary indexes on the live
 * cache after an upgrade left one missing or stale.
 *
 * SCOPE: only EXPLICIT secondary indexes - the rows `duckdb_indexes()`
 * reports for this DuckDB build. A primary key or a table-level `CONSTRAINT
 * ... UNIQUE (...)` never appears there: DuckDB enforces those through the
 * table's own constraint machinery, not a separate catalog index, so there is
 * nothing this command could rebuild for them even if asked - see
 * {@link INDEX_REPAIR_SCOPE_NOTE}, and `cache-bust-event-upgrade.test.ts` for
 * the upgrade defect this command exists to let an operator recover from
 * without a full reingest.
 *
 * Each index repairs as its OWN recoverable unit of work: DROP the existing
 * index, then re-run its own `CREATE [UNIQUE] INDEX` statement (read back
 * verbatim from `duckdb_indexes().sql`, so it reproduces the exact original
 * definition). This is NOT a real SQL `BEGIN`/`COMMIT` transaction, despite
 * that being the obvious way to write this: measured against this DuckDB
 * build, wrapping a same-name `DROP INDEX` + `CREATE INDEX` pair in one
 * explicit transaction crashes the native client outright (`libc++abi: Pure
 * virtual function called!`) - reproduced with `BEGIN TRANSACTION` alone
 * around the pair, on both a failing and a succeeding `CREATE`, and confirmed
 * absent the moment either the transaction wrapper or the same-name reuse is
 * removed. So `repairOneIndex` reads the index's CURRENT definition before
 * touching anything, drops it, and on a `CREATE` failure re-runs that
 * captured definition as a COMPENSATING action standing in for a rollback
 * the native binding cannot execute - this is NOT a SQL transaction rollback,
 * and it does not offer transactional guarantees. If that compensating
 * restore itself fails, the catalog is left in a state this module cannot
 * reconcile (the index dropped, neither the new nor the original definition
 * in place), and `repairOneIndex` propagates {@link IndexRestoreFailedError}
 * rather than reporting a per-index outcome - see there for why that must be
 * fatal to the whole run.
 *
 * PUBLISH GATING mirrors the seam's own maintenance-write rule (see
 * `CacheWriteOptions.publish` in `@ax/lib/duckdb/seam`): this command opens
 * the live cache with the DDL disabled (it must be usable against a cache an
 * upgrade already left in a broken state - see `withCacheWrite`'s
 * `schemaSql: null` case). A dry-run passes `publish: false` outright, since
 * it never touches the catalog. A real repair uses `withCacheWrite`'s own
 * on-success publish - NOT `CacheWriteService.publishIntermediateSnapshot()`,
 * which is a narrow escape hatch reserved for ingest's cold-start path (see
 * its own doc comment) and is not a sanctioned caller here. Instead,
 * `repairIndexList` fails its own body with the typed
 * {@link IndexRepairIncompleteError} whenever the pass was not a clean sweep
 * (nothing discovered, or at least one index failed) - a failed body is
 * exactly what stops `withCacheWrite` from publishing. `cmdIngestRepairIndexes`
 * handles that ONE typed error outside `withCacheWrite`. An empty pass returns
 * a successful no-op result. A pass with failed repairs remains a typed CLI
 * failure. Every other error (`IndexRestoreFailedError`, or any
 * `CacheWriteError`) propagates unchanged. The live cache itself is never
 * deleted or rebuilt from scratch by any of this.
 */
import { Effect, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import {
    withCacheWrite,
    type CacheReadError,
    type CacheReadService,
    type CacheWriteError,
    type CacheWriteService,
} from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { posixPath } from "@ax/lib/shared/path";
import { duckdbAssetPathOption } from "../duckdb-embed-wiring.ts";

export const INDEX_REPAIR_SCOPE_NOTE =
    "scope: explicit secondary indexes only - primary-key and UNIQUE-constraint-backed indexes " +
    "are enforced by the table itself, never appear in duckdb_indexes(), and are unsupported here.";

export interface RepairableIndex {
    readonly indexName: string;
    readonly tableName: string;
    readonly isUnique: boolean;
    /** The index's own `CREATE [UNIQUE] INDEX ...` statement, verbatim from
     *  `duckdb_indexes().sql` - reproducing it is what "repair" means. */
    readonly createSql: string;
}

export interface IndexRepairOutcome {
    readonly indexName: string;
    readonly tableName: string;
    readonly status: "repaired" | "failed" | "would-repair";
    readonly error?: string | undefined;
}

export interface IndexRepairResult {
    readonly dryRun: boolean;
    readonly outcomes: readonly IndexRepairOutcome[];
    readonly repaired: number;
    readonly failed: number;
}

/** A compensating restore (re-running an index's captured original
 *  definition) itself failed after a DROP and a failed CREATE. Unlike a
 *  per-index `"failed"` outcome - where the DROP never ran, or it did and the
 *  restore put the catalog back - this leaves the catalog in a state this
 *  module cannot reconcile: the index is gone, and neither the attempted new
 *  definition nor the original one is in place. It is FATAL rather than a
 *  reported outcome for exactly that reason: it propagates out of
 *  `repairOneIndex` uncaught, past `repairIndexList`, and fails the
 *  `withCacheWrite` body - so the run can never publish over it. */
export class IndexRestoreFailedError extends Schema.TaggedErrorClass<IndexRestoreFailedError>(
    "IndexRestoreFailedError",
)("IndexRestoreFailedError", {
    indexName: Schema.String,
    tableName: Schema.String,
    createError: Schema.String,
    restoreError: Schema.String,
    message: Schema.String,
}) {}

/** Raised from `repairIndexList`'s write body whenever a non-dry-run pass was
 *  not a clean sweep - nothing was discovered to repair, or at least one
 *  index came back `"failed"`. Failing the body is what stops
 *  `withCacheWrite`'s on-success publish from firing; it carries the
 *  already-computed {@link IndexRepairResult} so `cmdIngestRepairIndexes` can
 *  catch it OUTSIDE `withCacheWrite` and still hand the CLI a result to
 *  format, without that catch masking any other `CacheWriteError`. */
export class IndexRepairIncompleteError extends Schema.TaggedErrorClass<IndexRepairIncompleteError>(
    "IndexRepairIncompleteError",
)("IndexRepairIncompleteError", {
    message: Schema.String,
    result: Schema.Struct({
        dryRun: Schema.Boolean,
        outcomes: Schema.Array(
            Schema.Struct({
                indexName: Schema.String,
                tableName: Schema.String,
                status: Schema.Literals(["repaired", "failed", "would-repair"]),
                error: Schema.optional(Schema.String),
            }),
        ),
        repaired: Schema.Number,
        failed: Schema.Number,
    }),
}) {}

export class IndexRepairBusyError extends Schema.TaggedErrorClass<IndexRepairBusyError>(
    "IndexRepairBusyError",
)("IndexRepairBusyError", {
    holderCommand: Schema.String,
    message: Schema.String,
}) {}

const RepairableIndexRow = Schema.Struct({
    index_name: Schema.String,
    table_name: Schema.String,
    is_unique: Schema.Boolean,
    sql: Schema.String,
});

const IndexSqlRow = Schema.Struct({ sql: Schema.String });

/** Quote a catalog identifier without restricting valid quoted names. */
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const writeErrorMessage = (error: CacheWriteError): string => error.message;

/** Every explicit secondary index on the live cache, read straight off the
 *  catalog. Never a primary key or a named UNIQUE constraint - see the module
 *  header for why those cannot appear here in the first place. */
export const listRepairableIndexes = (
    read: CacheReadService,
): Effect.Effect<readonly RepairableIndex[], CacheReadError> =>
    read
        .rows(
            RepairableIndexRow,
            "SELECT index_name, table_name, is_unique, sql FROM duckdb_indexes() " +
                "WHERE NOT is_primary AND sql IS NOT NULL ORDER BY index_name",
        )
        .pipe(
            Effect.map((rows) =>
                rows.map((row): RepairableIndex => ({
                    indexName: row.index_name,
                    tableName: row.table_name,
                    isUnique: row.is_unique,
                    createSql: row.sql,
                })),
            ),
        );

/** After a CREATE fails, re-run the index's captured `originalSql` to put the
 *  catalog back where it was. If that restore itself fails, the outcome is no
 *  longer representable as a per-index `"failed"` result - fail fatally with
 *  {@link IndexRestoreFailedError} instead (see its own doc comment). */
const restoreAfterFailedCreate = (
    write: CacheWriteService,
    index: RepairableIndex,
    originalSql: unknown,
    createError: CacheWriteError,
): Effect.Effect<IndexRepairOutcome, IndexRestoreFailedError> =>
    Effect.gen(function* () {
        if (typeof originalSql !== "string") {
            return {
                indexName: index.indexName,
                tableName: index.tableName,
                status: "failed" as const,
                error: writeErrorMessage(createError),
            };
        }

        const restored = yield* Effect.result(write.exec(originalSql));
        if (restored._tag === "Failure") {
            return yield* new IndexRestoreFailedError({
                indexName: index.indexName,
                tableName: index.tableName,
                createError: writeErrorMessage(createError),
                restoreError: writeErrorMessage(restored.failure),
                message:
                    `repair-indexes: ${index.tableName}.${index.indexName} - index creation failed and the compensating ` +
                    "restore of its original definition ALSO failed. The catalog is left without this index and " +
                    "this run's publish is blocked - investigate the live cache directly before retrying.",
            });
        }

        return {
            indexName: index.indexName,
            tableName: index.tableName,
            status: "failed" as const,
            error: writeErrorMessage(createError),
        };
    });

/**
 * Rebuild one index: DROP it, then re-run its own `createSql`. Not a real SQL
 * transaction - see the module header for why that crashes the native
 * client. If the DROP itself fails, nothing has changed and the failure is
 * reported as a per-index `"failed"` outcome. If the CREATE fails AFTER a
 * successful DROP, the index's definition as read BEFORE this call
 * (`originalSql`) is re-run to put the catalog back where it was; if THAT
 * restore also fails, this propagates {@link IndexRestoreFailedError} rather
 * than reporting an outcome. Every other failure reports `"failed"` instead
 * of propagating, so one bad index never aborts the rest of the pass.
 */
export const repairOneIndex = (
    write: CacheWriteService,
    index: RepairableIndex,
): Effect.Effect<IndexRepairOutcome, IndexRestoreFailedError> =>
    Effect.gen(function* () {
        const before = yield* write.rows(IndexSqlRow, "SELECT sql FROM duckdb_indexes() WHERE index_name = ?", [
            index.indexName,
        ]);
        const originalSql = before[0]?.sql;

        yield* write.exec(`DROP INDEX ${quoteIdentifier(index.indexName)}`);

        return yield* write.exec(index.createSql).pipe(
            Effect.as({
                indexName: index.indexName,
                tableName: index.tableName,
                status: "repaired" as const,
            }),
            Effect.catch((createError) => restoreAfterFailedCreate(write, index, originalSql, createError)),
        );
    }).pipe(
        // Only IndexRestoreFailedError (raised above) is fatal - every other
        // failure along this path (the lookup query, the DROP itself) is a
        // normal per-index outcome, never a reason to abort the whole pass.
        Effect.catchIf(
            (error): error is CacheWriteError => error._tag !== "IndexRestoreFailedError",
            (error) =>
                Effect.succeed({
                    indexName: index.indexName,
                    tableName: index.tableName,
                    status: "failed" as const,
                    error: writeErrorMessage(error),
                }),
        ),
    );

/** Publish only when there was something to repair and every one of them
 *  repaired cleanly - never for a dry-run's `would-repair` outcomes, never
 *  for a no-op empty run, and never alongside even one failure. */
export const planPublish = (outcomes: ReadonlyArray<Pick<IndexRepairOutcome, "status">>): boolean =>
    outcomes.length > 0 && outcomes.every((o) => o.status === "repaired");

/** Repair (or, in dry-run, merely report) every index in `indexes`. A
 *  dry-run always succeeds. A real pass succeeds ONLY when
 *  {@link planPublish} would say yes to the result it just computed;
 *  otherwise it fails the whole effect with {@link IndexRepairIncompleteError}
 *  carrying that same result, so `withCacheWrite`'s on-success publish never
 *  fires over a no-op or partially-failed run. */
export const repairIndexList = (
    write: CacheWriteService,
    indexes: readonly RepairableIndex[],
    dryRun: boolean,
): Effect.Effect<IndexRepairResult, IndexRestoreFailedError | IndexRepairIncompleteError> =>
    Effect.gen(function* () {
        if (dryRun) {
            const outcomes: IndexRepairOutcome[] = indexes.map((index) => ({
                indexName: index.indexName,
                tableName: index.tableName,
                status: "would-repair" as const,
            }));
            return { dryRun: true, outcomes, repaired: 0, failed: 0 };
        }

        const outcomes: IndexRepairOutcome[] = [];
        for (const index of indexes) {
            outcomes.push(yield* repairOneIndex(write, index));
        }

        const result: IndexRepairResult = {
            dryRun: false,
            outcomes,
            repaired: outcomes.filter((o) => o.status === "repaired").length,
            failed: outcomes.filter((o) => o.status === "failed").length,
        };

        if (!planPublish(outcomes)) {
            return yield* new IndexRepairIncompleteError({
                result,
                message: formatIndexRepairResult(result),
            });
        }
        return result;
    });

/** Discover, then repair (or preview) every explicit secondary index. */
export const runIndexRepair = (
    write: CacheWriteService,
    opts: { readonly dryRun: boolean },
): Effect.Effect<IndexRepairResult, CacheReadError | IndexRestoreFailedError | IndexRepairIncompleteError> =>
    Effect.gen(function* () {
        const indexes = yield* listRepairableIndexes(write);
        return yield* repairIndexList(write, indexes, opts.dryRun);
    });

export const formatIndexRepairResult = (result: IndexRepairResult): string => {
    const verb = result.dryRun ? "would repair" : "repaired";
    // A dry-run's `repaired` counter is always 0 (nothing is actually
    // touched) - the count worth showing is how many indexes were
    // DISCOVERED, i.e. every outcome, all of which are "would-repair".
    const count = result.dryRun ? result.outcomes.length : result.repaired;
    const lines: string[] = [
        `ingest repair-indexes: ${verb} ${count}/${result.outcomes.length} explicit secondary index(es)` +
            (result.failed > 0 ? `, ${result.failed} FAILED` : "") +
            (result.dryRun ? " (dry-run)" : ""),
    ];
    for (const outcome of result.outcomes) {
        if (outcome.status === "failed") {
            lines.push(`  FAILED  ${outcome.tableName}.${outcome.indexName} - ${outcome.error ?? "unknown error"}`);
        }
    }
    if (!result.dryRun) {
        lines.push(
            result.failed > 0
                ? "  snapshot NOT published - fix the failed index(es) and re-run."
                : result.outcomes.length > 0
                  ? "  snapshot published."
                  : "  nothing to repair - snapshot NOT published.",
        );
    }
    lines.push(`  ${INDEX_REPAIR_SCOPE_NOTE}`);
    return lines.join("\n");
};

/**
 * `ax ingest repair-indexes` end to end: acquire the ingest lock, open the
 * live cache with schema application disabled (this command must work even
 * when the live cache is in whatever broken state an upgrade left it in),
 * repair every discovered index, and publish only on a clean sweep.
 *
 * Dry-run opens with `publish: false` outright. A real repair opens with
 * `withCacheWrite`'s normal on-success publish and relies on
 * `runIndexRepair` failing its own body (via `IndexRepairIncompleteError`)
 * whenever the pass was not a clean sweep - that failed body is what blocks
 * the publish. The catch below is scoped to that ONE typed error and applies
 * OUTSIDE `withCacheWrite`. An empty pass becomes a successful no-op result.
 * A real repair failure remains typed, so the CLI exits nonzero.
 * `IndexRestoreFailedError` and every other `CacheWriteError` also propagate.
 */
export const cmdIngestRepairIndexes = (opts: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const dataDir = cfg.paths.dataDir;
        const lockPath = posixPath.join(dataDir, "ingest.lock");

        const outcome = yield* withIngestLock(
            {
                lockPath,
                command: "ingest repair-indexes",
                staleMs: 60_000,
                onBusy: (holder) =>
                    Effect.fail(
                        new IndexRepairBusyError({
                            holderCommand: holder.command,
                            message: `ingest repair-indexes: another ingest holds the cache lock (${holder.command})`,
                        }),
                    ),
            },
            withCacheWrite(
                {
                    livePath: posixPath.join(dataDir, "ax-live.duckdb"),
                    lockPath,
                    snapshotPath: posixPath.join(dataDir, "ax-snapshot.duckdb"),
                    schemaSql: null,
                    publish: !opts.dryRun,
                    ...duckdbAssetPathOption(),
                },
                (write) => runIndexRepair(write, { dryRun: opts.dryRun }),
            ).pipe(
                Effect.catchTag("IndexRepairIncompleteError", (error) =>
                    error.result.failed === 0 ? Effect.succeed(error.result) : Effect.fail(error),
                ),
            ),
        );
        if (outcome._tag !== "completed") {
            return yield* Effect.die(`ingest repair-indexes did not complete: ${outcome._tag}`);
        }
        return outcome.value;
    });
