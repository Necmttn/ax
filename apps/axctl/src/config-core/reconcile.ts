import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { withCacheWrite } from "@ax/lib/duckdb/seam";
import { buildFtsIndexes } from "@ax/lib/duckdb/fts";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { posixPath } from "@ax/lib/shared/path";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";

export const withConfigWrite = <A, E, R>(
    use: (write: CacheWriteService) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CacheWriteError, AxConfig | FileSystem.FileSystem | Path.Path | R> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const lockPath = posixPath.join(cfg.paths.dataDir, "ingest.lock");
        const outcome = yield* withIngestLock(
            {
                lockPath,
                command: "config-write",
                staleMs: 60_000,
                onBusy: (holder) => Effect.die(`ingest lock is busy: ${holder.command}`),
            },
            withCacheWrite(
                {
                    livePath: posixPath.join(cfg.paths.dataDir, "ax-live.duckdb"),
                    lockPath,
                    schemaSql: DUCKDB_SCHEMA_SQL,
                },
                (write) => use(write).pipe(Effect.tap(() => buildFtsIndexes(write))),
            ),
        );
        if (outcome._tag === "completed") return outcome.value;
        return yield* Effect.die(`config write did not complete: ${outcome._tag}`);
    });

/**
 * Generic soft-tombstone reconcile, shared by skills + agents. Given the set of
 * names that exist ON DISK right now, it:
 *   - tombstones DB rows absent from disk  (`deleted_at = time::now()`),
 *   - resurrects + touches rows present on disk (`deleted_at = NONE`,
 *     `last_seen_at = time::now()`).
 * Soft (not hard) delete preserves historical `invoked` evidence. Hooks do NOT
 * use this (config-only, no graph rows).
 *
 * SAFETY (the tombstone half is destructive and trusts the snapshot as truth):
 *   - EMPTY snapshot tombstones nothing unless `allowEmpty`.
 *   - DEGRADED snapshot: callers pass `tombstone: false` when a source failed to
 *     enumerate, so a transient unreadable root can't mass-delete rows.
 *   - IMPLAUSIBLE snapshot: even a "successful" but incomplete discovery (e.g. a
 *     codec that under-finds) would wipe the table; if the would-be tombstone
 *     share exceeds `maxTombstoneFraction` of live rows, the destructive pass is
 *     refused and `tombstoneSkipped` is set. Resurrect/touch always runs (safe).
 *
 * `table` is a controlled constant (caller literal), never user input; the
 * on-disk name list is passed as a `$names` binding.
 */
export interface ReconcileReport {
    readonly table: string;
    readonly tombstoned: number;
    readonly resurrected: number;
    readonly touched: number;
    readonly dryRun: boolean;
    /** True when the destructive tombstone pass was skipped for a safety reason. */
    readonly tombstoneSkipped: boolean;
    /** Why it was skipped (for the CLI to surface), or null when it ran. */
    readonly skipReason: "empty" | "incomplete" | "implausible" | null;
    /** Rows the tombstone pass would affect (reported even when skipped). */
    readonly wouldTombstone: number;
}

export interface ReconcileOptions {
    readonly dryRun?: boolean;
    /** Permit tombstoning even from an empty on-disk snapshot. Default false. */
    readonly allowEmpty?: boolean;
    /** Caller asserts the snapshot is complete. Default true; pass false when any
     *  source failed to enumerate so orphans aren't falsely deleted. */
    readonly tombstone?: boolean;
    /** Refuse to tombstone if absent/live exceeds this. Default 0.5. */
    readonly maxTombstoneFraction?: number;
    /** Constrain the whole pass to one `scope` value (e.g. "user", "plugin:x").
     *  Rows of other scopes are never read or touched. */
    readonly scope?: string;
}

/** One-line human summary, surfacing a refused/degraded tombstone pass loudly. */
export const formatReconcile = (r: ReconcileReport): string => {
    const head = `reconcile ${r.table}: tombstoned=${r.tombstoned} resurrected=${r.resurrected} touched=${r.touched}${r.dryRun ? " (dry-run)" : ""}`;
    if (!r.tombstoneSkipped) return head;
    const why = {
        empty: "empty on-disk snapshot",
        incomplete: "discovery was incomplete (a source failed to read)",
        implausible: `would delete ${r.wouldTombstone} rows (>${"50%"} of live) - discovery likely diverged`,
    }[r.skipReason ?? "incomplete"];
    return `${head}\n  ⚠ tombstone SKIPPED: ${why}. ${r.wouldTombstone} row(s) left untouched. Fix discovery before reconciling.`;
};

// `$scope` is appended by the caller when a scope is supplied (see scopeClause).
const allowedTable = (table: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid reconcile table: ${table}`);
    return `"${table}"`;
};

export const reconcileTable = (
    write: CacheWriteService,
    table: string,
    onDiskNames: readonly string[],
    opts: ReconcileOptions = {},
): Effect.Effect<ReconcileReport, CacheWriteError> =>
    Effect.gen(function* () {
        const names = Array.from(new Set(onDiskNames));
        const dryRun = opts.dryRun ?? false;
        const maxFraction = opts.maxTombstoneFraction ?? 0.5;

        // When a scope is given, EVERY predicate is constrained to it, so a
        // reconcile of `user` can never touch `plugin:x`, a tool row, or a
        // project skill from another repo. Rows outside the current discovery's
        // scopes are left strictly alone.
        const tableName = allowedTable(table);
        const inClause = names.length === 0 ? "FALSE" : `name IN (${names.map(() => "?").join(", ")})`;
        const scopeClause = opts.scope !== undefined ? " AND scope = ?" : "";
        const bind = [...names, ...(opts.scope !== undefined ? [opts.scope] : [])];
        const countWhere = (where: string) =>
            write.first(
                Schema.Struct({ n: Schema.BigInt }),
                `SELECT count(*) AS n FROM ${tableName} WHERE ${where}${scopeClause}`,
                bind,
            ).pipe(Effect.map((row) => Number(Option.getOrElse(row, () => ({ n: 0n })).n)));

        // Inspect before mutating: how many would be tombstoned vs how many live.
        const wouldTombstone = yield* countWhere(`NOT (${inClause}) AND deleted_at IS NULL`);
        const liveTotal = (yield* countWhere(`${inClause} AND deleted_at IS NULL`)) + wouldTombstone;

        let skipReason: ReconcileReport["skipReason"] = null;
        if ((opts.tombstone ?? true) === false) skipReason = "incomplete";
        else if (names.length === 0 && !(opts.allowEmpty ?? false)) skipReason = "empty";
        else if (liveTotal > 0 && wouldTombstone / liveTotal > maxFraction && !(opts.allowEmpty ?? false))
            skipReason = "implausible";
        const tombstoneSkipped = skipReason !== null;

        const mutate = (where: string, set: string) =>
            write.exec(`UPDATE ${tableName} SET ${set} WHERE ${where}${scopeClause}`, bind);

        // tombstone pass: skip entirely (0) when unsafe; report the count in dry-run.
        const tombstoned = tombstoneSkipped
            ? 0
            : dryRun
                ? wouldTombstone
                : yield* mutate(`NOT (${inClause}) AND deleted_at IS NULL`, "deleted_at = CURRENT_TIMESTAMP");
        const resurrected = dryRun
            ? yield* countWhere(`${inClause} AND deleted_at IS NOT NULL`)
            : yield* mutate(`${inClause} AND deleted_at IS NOT NULL`, "deleted_at = NULL, last_seen_at = CURRENT_TIMESTAMP");
        const touched = dryRun ? liveTotal - wouldTombstone : yield* mutate(`${inClause} AND deleted_at IS NULL`, "last_seen_at = CURRENT_TIMESTAMP");

        return { table, tombstoned, resurrected, touched, dryRun, tombstoneSkipped, skipReason, wouldTombstone };
    });

export interface ScopedReconcileReport extends ReconcileReport {
    readonly perScope: ReadonlyArray<{ readonly scope: string; readonly report: ReconcileReport }>;
}

/**
 * Reconcile per discovered scope, so only scopes the current discovery OWNS are
 * touched. DB rows whose scope is absent from `byScope` (other repos' project
 * skills, provider tools, unknowns) are never read or tombstoned. Each scope
 * also gets its own safety guard, so one diverging scope can't drag the rest.
 */
export const reconcileByScope = (
    write: CacheWriteService,
    table: string,
    byScope: ReadonlyMap<string, readonly string[]>,
    opts: Omit<ReconcileOptions, "scope"> = {},
): Effect.Effect<ScopedReconcileReport, CacheWriteError> =>
    Effect.gen(function* () {
        const perScope: Array<{ scope: string; report: ReconcileReport }> = [];
        for (const [scope, names] of byScope) {
            const report = yield* reconcileTable(write, table, names, { ...opts, scope });
            perScope.push({ scope, report });
        }
        const sum = (f: (r: ReconcileReport) => number): number =>
            perScope.reduce((acc, p) => acc + f(p.report), 0);
        const skipped = perScope.filter((p) => p.report.tombstoneSkipped);
        return {
            table,
            tombstoned: sum((r) => r.tombstoned),
            resurrected: sum((r) => r.resurrected),
            touched: sum((r) => r.touched),
            dryRun: opts.dryRun ?? false,
            tombstoneSkipped: skipped.length > 0,
            skipReason: skipped[0]?.report.skipReason ?? null,
            wouldTombstone: sum((r) => r.wouldTombstone),
            perScope,
        };
    });

/** Scoped summary: totals + a line per scope whose tombstone pass was refused. */
export const formatReconcileScoped = (r: ScopedReconcileReport): string => {
    const head = `reconcile ${r.table}: tombstoned=${r.tombstoned} resurrected=${r.resurrected} touched=${r.touched} across ${r.perScope.length} scope(s)${r.dryRun ? " (dry-run)" : ""}`;
    const skips = r.perScope
        .filter((p) => p.report.tombstoneSkipped)
        .map((p) => `  ⚠ ${p.scope}: tombstone skipped (${p.report.skipReason}, would delete ${p.report.wouldTombstone})`);
    return skips.length ? `${head}\n${skips.join("\n")}` : head;
};
