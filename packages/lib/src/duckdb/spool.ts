/**
 * NDJSON spool for high-volume ingest writes (v3 Phase 2, #886).
 *
 * `putMany` binds every value of every row as a prepared-statement parameter -
 * correct, and measured too slow at corpus scale: an ingest run is ~100%
 * database time, and the same rows load orders of magnitude faster through one
 * `read_ndjson` scan per table. So a SPOOLED table's rows accumulate in memory
 * across many files and land as ONE
 * `INSERT ... SELECT ... FROM read_ndjson(...) ON CONFLICT ("id") DO UPDATE`
 * per (table, column-signature) per flush.
 *
 * WHAT THIS MODULE PRESERVES from the seam's bound-param path (`seam.ts`
 * `putMany`/`insertStatement` - drift here is silent data corruption):
 *
 *  - EXPLICIT COLUMNS ALWAYS. `read_ndjson` runs with a `columns={...}` map
 *    generated from the committed DDL (`@ax/schema` `parseDuckdbColumnDefs`),
 *    never inference - the v3 proto re-earned an inference bug within minutes.
 *  - PER-SIGNATURE BATCHES. Two writes to the same table may carry DIFFERENT
 *    column subsets (nullable columns omitted). One merged file would make
 *    `read_ndjson` yield NULL for a row's missing keys, and the upsert would
 *    then overwrite existing values the narrower statement never touches. Rows
 *    are grouped by their sorted column signature, one load per group. (Within
 *    ONE flush, the order of two same-id rows in DIFFERENT signature groups is
 *    unspecified - same nondeterminism two interleaved putMany calls had.)
 *  - LAST WRITE WINS PER id. Ingest legitimately re-emits the same row many
 *    times per run (`tool` and `file` on every tool call) and relies on upsert
 *    dedup. DuckDB silently keeps one row when a `read_ndjson` source carries
 *    duplicate conflict keys, so each buffer dedups by ENCODED id at append.
 *    The later row replaces the earlier one, matching back-to-back upserts.
 *  - THE `id` INVARIANT + explicit conflict target. `INSERT OR REPLACE` is
 *    unusable on this schema (secondary UNIQUE indexes); the conflict target is
 *    `("id")`, the same statement shape as the seam's.
 *  - `WRITE_STAMPED_COLUMNS`: a caller value for a stamped column is dropped
 *    and the SELECT list emits `CURRENT_TIMESTAMP` instead.
 *  - NUL STRIPPING. Spooled values bypass the seam's bound-param scrub, so the
 *    serializer strips U+0000 itself and counts what it scrubbed, mirroring
 *    `nulStripped` (sanitising silently is the failure class the seam refuses).
 *  - BIGINT EXACTNESS. JSON has no bigint: a `bigint` is emitted as a DECIMAL
 *    STRING and the column's declared type (BIGINT) casts it back losslessly
 *    inside DuckDB - never through a JS double. Range-guarded to int64 exactly
 *    like the bind path.
 *
 * WHAT CHANGES, deliberately (a documented trade, not an accident):
 *
 *  - VISIBILITY. A spooled row is invisible to SQL until `flush`. Only tables
 *    with NO same-run read-back may spool; the #886 survey pinned the set
 *    (`INGEST_SPOOL_TABLES` in the jsonl work-unit) and `session`/`skill`/the
 *    plan family stay on the direct path.
 *  - DELETE ORDERING. `exec` (e.g. the once-per-session `DELETE FROM
 *    agent_event`) passes through IMMEDIATELY while inserts land at flush.
 *    That preserves delete-before-insert ONLY because every such DELETE fires
 *    before the first append for its session (guarded once per session per
 *    run). A DELETE issued after rows for its key were appended would miss
 *    them - do not add one.
 *  - FAILURE GRAIN. A flush failure loses the whole window, not one file. The
 *    durable contract is unchanged - ingest was never per-file transactional,
 *    and a watermark still only commits AFTER its rows land (the work-unit
 *    defers marks past the flush) - only the retry batch grows.
 *
 * Runtime module - no `node:fs`/`node:path`; `Bun.write`/`Bun.file` for the
 * spool files, `posixPath` for joins.
 */
import { Cause, Effect, Exit, Semaphore } from "effect";
import { parseDuckdbColumnDefs } from "@ax/schema/duckdb-ddl";
import { posixPath } from "../shared/path.ts";
import { DuckDbQueryError } from "./errors.ts";
import { WRITE_STAMPED_COLUMNS, type CacheWriteError, type CacheWriteService } from "./seam.ts";
import type { DuckDbParam } from "./types.ts";

/** Mirror of the bind path's int64 bounds (client.ts `bindableBigInt`). */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SpoolTotals {
    /** Rows landed through the spool since construction. */
    readonly rows: number;
    /** Load statements issued (one per (table, signature) per flush). */
    readonly statements: number;
    /** Successful limit-triggered flush operations. Explicit flushes are excluded. */
    readonly automaticFlushes: number;
    /** Text values that carried a U+0000 and were scrubbed. */
    readonly nulValues: number;
    /** Text values with an unpaired UTF-16 surrogate, made well-formed
     *  (lone half -> U+FFFD). See {@link encodeValue} for why. */
    readonly illFormedValues: number;
    /** Highest number of retained rows observed after an append. */
    readonly peakPendingRows: number;
    /** Highest serialized UTF-8 byte count observed, including newlines. */
    readonly peakPendingBytes: number;
}

export interface SpoolFlushOutcome {
    readonly rows: number;
    readonly statements: number;
}

export interface TableSpool {
    /** The tables this spool intercepts. */
    readonly tables: ReadonlySet<string>;
    /** Buffer rows for `table` (must be in {@link tables}). Enforces the same
     *  invariants as the seam's `putMany` (string `id` on every row, no ragged
     *  batch within one call). Synchronous; throws `DuckDbQueryError`. */
    readonly append: (table: string, rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>) => void;
    /** Validate a complete batch, then append it incrementally under the spool
     *  gate. Configured limits can flush rows before this effect returns. */
    readonly appendBounded: (
        write: CacheWriteService,
        table: string,
        rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>,
    ) => Effect.Effect<void, CacheWriteError>;
    /** Rows currently buffered across all tables (post-dedup). */
    readonly pendingRows: () => number;
    /** Serialized UTF-8 bytes currently buffered, including one newline per row. */
    readonly pendingBytes: () => number;
    /** Wait for active bounded work, then replay the first flush failure. */
    readonly assertHealthy: () => Effect.Effect<void, CacheWriteError>;
    /** Land every buffered row. Rows appended DURING the flush (concurrent
     *  fibers mid-file) stay buffered for the next one. */
    readonly flush: (write: CacheWriteService) => Effect.Effect<SpoolFlushOutcome, CacheWriteError>;
    /** Running totals for end-of-stage reporting. */
    readonly totals: () => SpoolTotals;
}

export interface TableSpoolOptions {
    /** Tables allowed to spool. Every entry must exist in the DDL. */
    readonly tables: ReadonlyArray<string>;
    /** Scratch dir for the NDJSON files. The caller owns its lifecycle (create
     *  a temp dir, remove it after the last flush); flushed files are unlinked
     *  best-effort as each load lands. */
    readonly dir: string;
    /** DDL override for tests. Defaults to the committed schema. */
    readonly ddlSql?: string;
    /** Optional retained-data limits. Omission preserves manual buffering. */
    readonly limits?: {
        readonly maxRows: number;
        readonly maxBytes: number;
    };
}

/** JSON-safe encoding of one value, matching the bind path's semantics. */
const encodeValue = (
    table: string,
    column: string,
    value: DuckDbParam,
    onNul: () => void,
    onIllFormed: () => void,
): string | number | boolean | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") {
        if (value < I64_MIN || value > I64_MAX) {
            throw new DuckDbQueryError({
                sql: `spool INSERT INTO ${table}`,
                message:
                    `spooled value for ${table}.${column} (${value}) is outside the signed 64-bit range this ` +
                    "store binds integers at; pass it as text (and store the column as VARCHAR or HUGEINT).",
            });
        }
        return value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    let text = value;
    if (!text.isWellFormed()) {
        // An unpaired UTF-16 surrogate (a truncated emoji half in a transcript,
        // #906). JSON.stringify would serialize it as a lone `\ud???` escape -
        // legal ECMA-404 text, but DuckDB's read_ndjson enforces strict UTF-8
        // and rejects the WHOLE file ("no low surrogate"), failing the stage.
        // The bind path tolerates the same value, so a fresh-store cold
        // backfill was the only run that hit it. Scrub to U+FFFD, counted -
        // silent sanitising is the failure class the seam refuses.
        onIllFormed();
        text = text.toWellFormed();
    }
    if (text.includes("\u0000")) {
        onNul();
        return text.replaceAll("\u0000", "");
    }
    return text;
};

interface SpoolBuffer {
    readonly table: string;
    /** Sorted signature columns, the emit order of every line's keys. */
    readonly columns: ReadonlyArray<string>;
    /** id -> serialized NDJSON line (sans newline). Later append wins. */
    readonly lines: Map<string, { readonly text: string; readonly bytes: number }>;
}

export const makeTableSpool = (options: TableSpoolOptions): TableSpool => {
    const tables = new Set(options.tables);
    const limits = options.limits;
    if (
        limits !== undefined &&
        (!Number.isFinite(limits.maxRows) || limits.maxRows <= 0 ||
            !Number.isFinite(limits.maxBytes) || limits.maxBytes <= 0)
    ) {
        throw new DuckDbQueryError({
            sql: "",
            message: "spool limits must contain positive finite maxRows and maxBytes values",
        });
    }

    /** table -> (column -> DDL type): the `columns={...}` source of truth. */
    const columnTypes = new Map<string, ReadonlyMap<string, string>>();
    for (const table of tables) {
        if (!IDENTIFIER.test(table)) {
            throw new DuckDbQueryError({
                sql: "",
                message: `refusing to spool table ${JSON.stringify(table)}: not a bare identifier`,
            });
        }
        const defs = parseDuckdbColumnDefs(table, options.ddlSql);
        if (defs.length === 0) {
            throw new DuckDbQueryError({
                sql: "",
                message: `refusing to spool table "${table}": no columns found in the DDL - the columns={} map would be empty`,
            });
        }
        for (const def of defs) {
            if (!IDENTIFIER.test(def.name) || !/^[A-Z]+$/.test(def.type)) {
                throw new DuckDbQueryError({
                    sql: "",
                    message:
                        `refusing to spool table "${table}": column ${JSON.stringify(def.name)} of type ` +
                        `${JSON.stringify(def.type)} does not fit the single-word shape the columns={} builder emits`,
                });
            }
        }
        columnTypes.set(table, new Map(defs.map((d) => [d.name, d.type])));
    }

    /** key = `${table} ${signature}` */
    const buffers = new Map<string, SpoolBuffer>();

    let totalRows = 0;
    let totalStatements = 0;
    let automaticFlushes = 0;
    let nulValues = 0;
    let illFormedValues = 0;
    let flushSeq = 0;
    let retainedRows = 0;
    let retainedBytes = 0;
    let peakPendingRows = 0;
    let peakPendingBytes = 0;
    let failedFlushCause: Cause.Cause<CacheWriteError> | null = null;
    const gate = Semaphore.makeUnsafe(1);
    const textEncoder = new TextEncoder();

    interface PreparedBatch {
        readonly table: string;
        readonly columns: ReadonlyArray<string>;
        readonly signature: string;
        readonly key: string;
    }

    const queryError = (table: string, message: string): DuckDbQueryError =>
        new DuckDbQueryError({ sql: `spool INSERT INTO ${table}`, message });

    /** Validate the complete input before bounded appends can flush any prefix. */
    const prepareBatch = (
        table: string,
        rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>,
    ): PreparedBatch | null => {
        if (rows.length === 0) return null;
        if (!tables.has(table)) {
            throw queryError(table, `table "${table}" is not in this spool's allowlist - route it through putMany`);
        }
        const stamped = WRITE_STAMPED_COLUMNS[table];
        const types = columnTypes.get(table)!;
        const columnsOf = (row: Readonly<Record<string, DuckDbParam>>): string[] =>
            Object.keys(row).filter((column) => column !== stamped);
        const columns = columnsOf(rows[0]!);
        if (!columns.includes("id")) {
            throw queryError(
                table,
                `spooled rows for ${table} need an \`id\` on every row (same invariant as putMany); got [${columns.join(", ")}]`,
            );
        }
        const sorted = [...columns].sort();
        const signature = sorted.join(",");
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            const rowColumns = columnsOf(row);
            for (const column of rowColumns) {
                if (!types.has(column)) {
                    throw queryError(
                        table,
                        `spooled row for ${table} carries column "${column}" which the DDL does not declare - ` +
                            "an explicit columns={} map cannot be built for it",
                    );
                }
            }
            const rowSignature = [...rowColumns].sort().join(",");
            if (rowSignature !== signature) {
                throw queryError(
                    table,
                    `spooled batch for ${table} is ragged: row ${index} has [${rowSignature}] while row 0 has ` +
                        `[${signature}]. Split into separate appends (same rule as putMany).`,
                );
            }
            const id = row["id"];
            if (typeof id !== "string" || id.length === 0) {
                throw queryError(
                    table,
                    `spooled row ${index} for ${table} has a non-string id (${typeof id}); every id in this schema is VARCHAR`,
                );
            }
            for (const column of sorted) {
                const value = row[column];
                if (typeof value === "bigint" && (value < I64_MIN || value > I64_MAX)) {
                    throw queryError(
                        table,
                        `spooled value for ${table}.${column} (${value}) is outside the signed 64-bit range this ` +
                            "store binds integers at; pass it as text (and store the column as VARCHAR or HUGEINT).",
                    );
                }
            }
        }
        return { table, columns: sorted, signature, key: `${table} ${signature}` };
    };

    const appendRow = (prepared: PreparedBatch, row: Readonly<Record<string, DuckDbParam>>): void => {
        let buffer = buffers.get(prepared.key);
        if (buffer === undefined) {
            buffer = { table: prepared.table, columns: prepared.columns, lines: new Map() };
            buffers.set(prepared.key, buffer);
        }
        const encodedId = encodeValue(prepared.table, "id", row["id"], () => {
            nulValues += 1;
        }, () => {
            illFormedValues += 1;
        });
        if (typeof encodedId !== "string") {
            throw queryError(prepared.table, `spooled row encoded its string id as ${typeof encodedId}`);
        }
        const out: Record<string, unknown> = {};
        for (const column of prepared.columns) {
            out[column] = column === "id"
                ? encodedId
                : encodeValue(prepared.table, column, row[column], () => {
                    nulValues += 1;
                }, () => {
                    illFormedValues += 1;
                });
        }
        const line = JSON.stringify(out);
        const lineBytes = textEncoder.encode(line).byteLength + 1;
        const replaced = buffer.lines.get(encodedId);
        if (replaced === undefined) retainedRows += 1;
        else retainedBytes -= replaced.bytes;
        buffer.lines.set(encodedId, { text: line, bytes: lineBytes });
        retainedBytes += lineBytes;
        peakPendingRows = Math.max(peakPendingRows, retainedRows);
        peakPendingBytes = Math.max(peakPendingBytes, retainedBytes);
    };

    const append: TableSpool["append"] = (table, rows) => {
        const prepared = prepareBatch(table, rows);
        if (prepared === null) return;
        for (const row of rows) appendRow(prepared, row);
    };

    const loadStatement = (buffer: SpoolBuffer, filePath: string): string => {
        const stamped = WRITE_STAMPED_COLUMNS[buffer.table];
        const types = columnTypes.get(buffer.table)!;
        const quoted = buffer.columns.map((c) => `"${c}"`);
        const columnsMap = buffer.columns.map((c) => `'${c}': '${types.get(c)!}'`).join(", ");
        const allColumns = stamped === undefined ? quoted : [...quoted, `"${stamped}"`];
        const selectList = stamped === undefined ? quoted.join(", ") : `${quoted.join(", ")}, CURRENT_TIMESTAMP`;
        const updates = allColumns.filter((c) => c !== '"id"').map((c) => `${c} = excluded.${c}`);
        const onConflict = updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;
        const escapedPath = filePath.replace(/'/g, "''");
        return (
            `INSERT INTO "${buffer.table}" (${allColumns.join(", ")}) ` +
            `SELECT ${selectList} FROM read_ndjson('${escapedPath}', ` +
            `format = 'newline_delimited', columns = {${columnsMap}}) ` +
            `ON CONFLICT ("id") ${onConflict}`
        );
    };

    const healthyUnsafe = (): Effect.Effect<void, CacheWriteError> =>
        failedFlushCause === null ? Effect.void : Effect.failCause(failedFlushCause);

    const flushUnsafe = (write: CacheWriteService): Effect.Effect<SpoolFlushOutcome, CacheWriteError> =>
        Effect.gen(function* () {
            yield* healthyUnsafe();
            const drained = [...buffers.values()].filter((b) => b.lines.size > 0);
            buffers.clear();
            retainedRows = 0;
            retainedBytes = 0;
            if (drained.length === 0) return { rows: 0, statements: 0 };

            flushSeq += 1;
            let rows = 0;
            let statements = 0;
            for (const buffer of drained) {
                const filePath = posixPath.join(options.dir, `${buffer.table}-${flushSeq}-${statements}.ndjson`);
                yield* Effect.tryPromise({
                    try: async () => {
                        let text = "";
                        for (const line of buffer.lines.values()) text += `${line.text}\n`;
                        await Bun.write(filePath, text, { createPath: true });
                    },
                    catch: (err) =>
                        new DuckDbQueryError({
                            sql: `spool INSERT INTO ${buffer.table}`,
                            message: `failed to write the spool file ${filePath}: ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        }),
                });
                // Through the seam's exec, so self-time charging and write
                // error mapping stay exactly as putMany's.
                yield* write.exec(loadStatement(buffer, filePath));
                rows += buffer.lines.size;
                statements += 1;
                totalRows += buffer.lines.size;
                totalStatements += 1;
                yield* Effect.tryPromise({
                    try: () => Bun.file(filePath).unlink(),
                    catch: () => undefined,
                }).pipe(Effect.ignore);
            }
            return { rows, statements };
        });

    const rememberFlushFailure = (
        effect: Effect.Effect<SpoolFlushOutcome, CacheWriteError>,
    ): Effect.Effect<SpoolFlushOutcome, CacheWriteError> =>
        effect.pipe(
            Effect.onExit((exit) =>
                Effect.sync(() => {
                    if (failedFlushCause === null && Exit.isFailure(exit)) failedFlushCause = exit.cause;
                }),
            ),
        );

    const flushHeld = (write: CacheWriteService): Effect.Effect<SpoolFlushOutcome, CacheWriteError> =>
        rememberFlushFailure(flushUnsafe(write));

    const flush: TableSpool["flush"] = (write) => gate.withPermits(1)(flushHeld(write));

    const appendBounded: TableSpool["appendBounded"] = (write, table, rows) => {
        const preparedEffect = Effect.try({
            try: () => prepareBatch(table, rows),
            catch: (error) => error instanceof DuckDbQueryError
                ? error
                : queryError(table, error instanceof Error ? error.message : String(error)),
        });
        return gate.withPermits(1)(
            Effect.gen(function* () {
                yield* healthyUnsafe();
                const prepared = yield* preparedEffect;
                if (prepared === null) return;
                for (const row of rows) {
                    appendRow(prepared, row);
                    if (
                        limits !== undefined &&
                        (retainedRows >= limits.maxRows || retainedBytes >= limits.maxBytes)
                    ) {
                        yield* flushHeld(write);
                        automaticFlushes += 1;
                    }
                }
            }),
        );
    };

    const assertHealthy: TableSpool["assertHealthy"] = () =>
        gate.withPermits(1)(Effect.suspend(healthyUnsafe));

    return {
        tables,
        append,
        appendBounded,
        pendingRows: () => retainedRows,
        pendingBytes: () => retainedBytes,
        assertHealthy,
        flush,
        totals: () => ({
            rows: totalRows,
            statements: totalStatements,
            automaticFlushes,
            nulValues,
            illFormedValues,
            peakPendingRows,
            peakPendingBytes,
        }),
    };
};

/**
 * Wrap a `CacheWriteService` so `put`/`putMany` for the spool's tables buffer
 * instead of writing; everything else - `exec`, reads, other tables - passes
 * through untouched. The caller owns the flush cadence (the jsonl work-unit)
 * and MUST flush before committing any watermark covering buffered rows.
 */
export const withTableSpool = (write: CacheWriteService, spool: TableSpool): CacheWriteService => ({
    ...write,
    putMany: (table, rows) =>
        spool.tables.has(table) ? spool.appendBounded(write, table, rows) : write.putMany(table, rows),
    put: (table, row) => spool.tables.has(table) ? spool.appendBounded(write, table, [row]) : write.put(table, row),
});
