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
 *    dedup. DuckDB REJECTS a statement whose source carries two rows with the
 *    same conflict key, so each buffer dedups by id at append - the later row
 *    replaces the earlier one, which is exactly what back-to-back upserts did.
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
import { Effect } from "effect";
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
    /** Text values that carried a U+0000 and were scrubbed. */
    readonly nulValues: number;
    /** Text values with an unpaired UTF-16 surrogate, made well-formed
     *  (lone half -> U+FFFD). See {@link encodeValue} for why. */
    readonly illFormedValues: number;
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
    /** Rows currently buffered across all tables (post-dedup). */
    readonly pendingRows: () => number;
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
    readonly lines: Map<string, string>;
}

export const makeTableSpool = (options: TableSpoolOptions): TableSpool => {
    const tables = new Set(options.tables);

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
    let nulValues = 0;
    let illFormedValues = 0;
    let flushSeq = 0;

    const append: TableSpool["append"] = (table, rows) => {
        if (rows.length === 0) return;
        if (!tables.has(table)) {
            throw new DuckDbQueryError({
                sql: `spool INSERT INTO ${table}`,
                message: `table "${table}" is not in this spool's allowlist - route it through putMany`,
            });
        }
        const stamped = WRITE_STAMPED_COLUMNS[table];
        const types = columnTypes.get(table)!;

        const columnsOf = (row: Readonly<Record<string, DuckDbParam>>): string[] =>
            Object.keys(row).filter((c) => c !== stamped);

        const columns = columnsOf(rows[0]!);
        if (!columns.includes("id")) {
            throw new DuckDbQueryError({
                sql: `spool INSERT INTO ${table}`,
                message: `spooled rows for ${table} need an \`id\` on every row (same invariant as putMany); got [${columns.join(", ")}]`,
            });
        }
        for (const column of columns) {
            if (!types.has(column)) {
                throw new DuckDbQueryError({
                    sql: `spool INSERT INTO ${table}`,
                    message:
                        `spooled row for ${table} carries column "${column}" which the DDL does not declare - ` +
                        "an explicit columns={} map cannot be built for it",
                });
            }
        }
        const sorted = [...columns].sort();
        const signature = sorted.join(",");
        const key = `${table} ${signature}`;
        let buffer = buffers.get(key);
        if (buffer === undefined) {
            buffer = { table, columns: sorted, lines: new Map() };
            buffers.set(key, buffer);
        }

        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i]!;
            if (i > 0) {
                const rowSignature = [...columnsOf(row)].sort().join(",");
                if (rowSignature !== signature) {
                    throw new DuckDbQueryError({
                        sql: `spool INSERT INTO ${table}`,
                        message:
                            `spooled batch for ${table} is ragged: row ${i} has [${rowSignature}] while row 0 has ` +
                            `[${signature}]. Split into separate appends (same rule as putMany).`,
                    });
                }
            }
            const id = row["id"];
            if (typeof id !== "string" || id.length === 0) {
                throw new DuckDbQueryError({
                    sql: `spool INSERT INTO ${table}`,
                    message: `spooled row ${i} for ${table} has a non-string id (${typeof id}); every id in this schema is VARCHAR`,
                });
            }
            const out: Record<string, unknown> = {};
            for (const column of buffer.columns) {
                out[column] = encodeValue(table, column, row[column], () => {
                    nulValues += 1;
                }, () => {
                    illFormedValues += 1;
                });
            }
            buffer.lines.set(id, JSON.stringify(out));
        }
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

    const flush: TableSpool["flush"] = (write) =>
        Effect.gen(function* () {
            // Snapshot-and-clear synchronously: rows appended by fibers still
            // mid-file after this point belong to the NEXT flush, together
            // with their files' watermarks (the work-unit snapshots marks
            // BEFORE calling flush, so a mark is never committed ahead of a
            // row it covers).
            const drained = [...buffers.values()].filter((b) => b.lines.size > 0);
            buffers.clear();
            if (drained.length === 0) return { rows: 0, statements: 0 };

            flushSeq += 1;
            let rows = 0;
            let statements = 0;
            for (const buffer of drained) {
                const filePath = posixPath.join(options.dir, `${buffer.table}-${flushSeq}-${statements}.ndjson`);
                yield* Effect.tryPromise({
                    try: async () => {
                        let text = "";
                        for (const line of buffer.lines.values()) text += `${line}\n`;
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
                yield* Effect.tryPromise({
                    try: () => Bun.file(filePath).unlink(),
                    catch: () => undefined,
                }).pipe(Effect.ignore);
            }
            totalRows += rows;
            totalStatements += statements;
            return { rows, statements };
        });

    return {
        tables,
        append,
        pendingRows: () => {
            let n = 0;
            for (const b of buffers.values()) n += b.lines.size;
            return n;
        },
        flush,
        totals: () => ({ rows: totalRows, statements: totalStatements, nulValues, illFormedValues }),
    };
};

const appendVia = (
    spool: TableSpool,
    table: string,
    rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>,
): Effect.Effect<void, CacheWriteError> =>
    Effect.try({
        try: () => spool.append(table, rows),
        catch: (err) =>
            err instanceof DuckDbQueryError
                ? err
                : new DuckDbQueryError({
                      sql: `spool INSERT INTO ${table}`,
                      message: err instanceof Error ? err.message : String(err),
                  }),
    });

/**
 * Wrap a `CacheWriteService` so `put`/`putMany` for the spool's tables buffer
 * instead of writing; everything else - `exec`, reads, other tables - passes
 * through untouched. The caller owns the flush cadence (the jsonl work-unit)
 * and MUST flush before committing any watermark covering buffered rows.
 */
export const withTableSpool = (write: CacheWriteService, spool: TableSpool): CacheWriteService => ({
    ...write,
    putMany: (table, rows) => (spool.tables.has(table) ? appendVia(spool, table, rows) : write.putMany(table, rows)),
    put: (table, row) => (spool.tables.has(table) ? appendVia(spool, table, [row]) : write.put(table, row)),
});
