/**
 * SQL model runner v1 (#888, v3 Phase 3).
 *
 * A MODEL is one .sql file that derives one table INSIDE DuckDB - the whole
 * read -> transform -> write round trip that a TS derive stage used to make,
 * collapsed into a single INSERT ... SELECT ... ON CONFLICT statement the
 * engine executes without rows ever crossing the JS boundary.
 *
 * Contract per file (parsed + validated by models.test.ts):
 *   -- model: <target table>
 *   -- inputs: <comma-separated source tables>     (validated against the DDL)
 *   -- rebuild: incremental | full_rebuild         (visible windowing claim)
 *
 * ONE statement per file. The since-window travels as a DuckDB variable
 * (`SET VARIABLE since_days`), never string interpolation into the model; a
 * model with `rebuild: incremental` MUST read `getvariable('since_days')` and
 * treat NULL as "no cutoff". Models run through the ordinary write seam
 * (`write.exec`), so self-time charging, ledger rows, and the derive budget
 * are exactly what a TS stage gets.
 *
 * v1 runs an explicit ordered list per stage; the `inputs` header seeds a
 * future topological runner once there is more than one dependency chain.
 */
import { Effect } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";

export interface SqlModel {
    /** Target table (== the `-- model:` header). */
    readonly name: string;
    /** The full statement, headers included. */
    readonly sql: string;
}

export interface ParsedModelHeader {
    readonly model: string;
    readonly inputs: readonly string[];
    readonly rebuild: "incremental" | "full_rebuild";
}

/** Parse the header contract. Throws on a malformed file - a model that does
 *  not declare its shape must not run. */
export const parseModelHeader = (sql: string): ParsedModelHeader => {
    const model = /^-- model:\s*(\S+)\s*$/m.exec(sql)?.[1];
    const inputs = /^-- inputs:\s*(.+)$/m.exec(sql)?.[1];
    const rebuild = /^-- rebuild:\s*(incremental|full_rebuild)\s*$/m.exec(sql)?.[1];
    if (!model || !inputs || !rebuild) {
        throw new Error(
            "SQL model is missing its header contract (-- model: / -- inputs: / -- rebuild:); refusing to run it",
        );
    }
    return {
        model,
        inputs: inputs.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
        rebuild: rebuild as ParsedModelHeader["rebuild"],
    };
};

/**
 * Run one model. `sinceDays` undefined = full derivation (the variable is set
 * to NULL, and an incremental model's cutoff predicate passes everything).
 * Returns the statement's changed-row count.
 */
export const runSqlModel = (
    write: CacheWriteService,
    model: SqlModel,
    sinceDays: number | undefined,
): Effect.Effect<number, CacheWriteError> =>
    Effect.gen(function* () {
        // The variable is session-scoped on the shared write connection, so it
        // is ALWAYS set (NULL included) - a stale value from a previous stage
        // must never leak into this run's window.
        const since =
            sinceDays !== undefined && Number.isFinite(sinceDays) && sinceDays > 0
                ? String(Math.trunc(sinceDays))
                : "NULL";
        yield* write.exec(`SET VARIABLE since_days = ${since}`);
        return yield* write.exec(model.sql);
    });
