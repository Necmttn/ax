import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

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
const ABSENT = "name NOT IN $names AND deleted_at IS NONE"; // on disk gone -> tombstone
const REVIVABLE = "name IN $names AND deleted_at IS NOT NONE"; // back on disk -> resurrect
const LIVE = "name IN $names AND deleted_at IS NONE"; // present -> touch

export const reconcileTable = (
    table: string,
    onDiskNames: readonly string[],
    opts: ReconcileOptions = {},
): Effect.Effect<ReconcileReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const names = Array.from(new Set(onDiskNames));
        const dryRun = opts.dryRun ?? false;
        const maxFraction = opts.maxTombstoneFraction ?? 0.5;

        // When a scope is given, EVERY predicate is constrained to it, so a
        // reconcile of `user` can never touch `plugin:x`, a tool row, or a
        // project skill from another repo. Rows outside the current discovery's
        // scopes are left strictly alone.
        const scopeClause = opts.scope !== undefined ? " AND scope = $scope" : "";
        const bind = opts.scope !== undefined ? { names, scope: opts.scope } : { names };

        const count = (rows: unknown): number => (Array.isArray(rows) ? rows.length : 0);
        const select = (where: string) =>
            db.query<[unknown[]]>(`SELECT id FROM ${table} WHERE ${where}${scopeClause}`, bind).pipe(
                Effect.map(([rows]) => count(rows)),
            );

        // Inspect before mutating: how many would be tombstoned vs how many live.
        const wouldTombstone = yield* select(ABSENT);
        const liveTotal = yield* select(LIVE).pipe(Effect.map((n) => n + wouldTombstone));

        let skipReason: ReconcileReport["skipReason"] = null;
        if ((opts.tombstone ?? true) === false) skipReason = "incomplete";
        else if (names.length === 0 && !(opts.allowEmpty ?? false)) skipReason = "empty";
        else if (liveTotal > 0 && wouldTombstone / liveTotal > maxFraction && !(opts.allowEmpty ?? false))
            skipReason = "implausible";
        const tombstoneSkipped = skipReason !== null;

        const mutate = (where: string, set: string) =>
            db.query<[unknown[]]>(`UPDATE ${table} SET ${set} WHERE ${where}${scopeClause}`, bind).pipe(
                Effect.map(([rows]) => count(rows)),
            );

        // tombstone pass: skip entirely (0) when unsafe; report the count in dry-run.
        const tombstoned = tombstoneSkipped
            ? 0
            : dryRun
                ? wouldTombstone
                : yield* mutate(ABSENT, "deleted_at = time::now()");
        const resurrected = dryRun
            ? yield* select(REVIVABLE)
            : yield* mutate(REVIVABLE, "deleted_at = NONE, last_seen_at = time::now()");
        const touched = dryRun ? liveTotal - wouldTombstone : yield* mutate(LIVE, "last_seen_at = time::now()");

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
    table: string,
    byScope: ReadonlyMap<string, readonly string[]>,
    opts: Omit<ReconcileOptions, "scope"> = {},
): Effect.Effect<ScopedReconcileReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const perScope: Array<{ scope: string; report: ReconcileReport }> = [];
        for (const [scope, names] of byScope) {
            const report = yield* reconcileTable(table, names, { ...opts, scope });
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
