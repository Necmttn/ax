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
 * `table` is a controlled constant (caller-supplied literal), never user input;
 * the on-disk name list is passed as a `$names` binding.
 */
export interface ReconcileReport {
    readonly table: string;
    readonly tombstoned: number;
    readonly resurrected: number;
    readonly touched: number;
    readonly dryRun: boolean;
}

export const reconcileTable = (
    table: string,
    onDiskNames: readonly string[],
    opts?: { readonly dryRun?: boolean },
): Effect.Effect<ReconcileReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const names = Array.from(new Set(onDiskNames));
        const dryRun = opts?.dryRun ?? false;

        const countOf = (rows: unknown): number =>
            Array.isArray(rows) ? rows.length : 0;

        if (dryRun) {
            const [orphans] = yield* db.query<[unknown[]]>(
                `SELECT id FROM ${table} WHERE name NOT IN $names AND deleted_at IS NONE`,
                { names },
            );
            const [revivable] = yield* db.query<[unknown[]]>(
                `SELECT id FROM ${table} WHERE name IN $names AND deleted_at IS NOT NONE`,
                { names },
            );
            const [live] = yield* db.query<[unknown[]]>(
                `SELECT id FROM ${table} WHERE name IN $names AND deleted_at IS NONE`,
                { names },
            );
            return {
                table,
                tombstoned: countOf(orphans),
                resurrected: countOf(revivable),
                touched: countOf(live),
                dryRun: true,
            };
        }

        const [tomb] = yield* db.query<[unknown[]]>(
            `UPDATE ${table} SET deleted_at = time::now() WHERE name NOT IN $names AND deleted_at IS NONE`,
            { names },
        );
        const [revived] = yield* db.query<[unknown[]]>(
            `UPDATE ${table} SET deleted_at = NONE, last_seen_at = time::now() WHERE name IN $names AND deleted_at IS NOT NONE`,
            { names },
        );
        const [touched] = yield* db.query<[unknown[]]>(
            `UPDATE ${table} SET last_seen_at = time::now() WHERE name IN $names AND deleted_at IS NONE`,
            { names },
        );

        return {
            table,
            tombstoned: countOf(tomb),
            resurrected: countOf(revived),
            touched: countOf(touched),
            dryRun: false,
        };
    });
