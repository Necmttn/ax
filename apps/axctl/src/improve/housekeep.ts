import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

/**
 * Housekeeping for the improve loop - a loop that suggests cleaning up
 * your workflow must not hoard its own stale state. No migration shims:
 * outdated rows are expired/deleted; the miners recreate anything still
 * real on the next pass (dedupe_sig brings the frequency back).
 *
 * Sweeps:
 *   1. Stale OPEN proposals - not re-observed (updated_at) within the
 *      window -> status 'superseded' with an explanatory reject_reason.
 *      Payload rows survive (REFERENCE CASCADE only fires on delete) but
 *      superseded proposals drop out of every active surface.
 *   2. Stale .ax/tasks briefs - emitted task/analyze/wrapped briefs older
 *      than the window are deleted (the generators re-emit on demand).
 */

export interface StaleProposalRow {
    readonly id: unknown;
    readonly title: string;
    readonly dedupe_sig: string;
    readonly form: string;
    readonly updated_at: string | null;
}

export interface HousekeepReport {
    readonly staleProposals: ReadonlyArray<StaleProposalRow>;
    readonly expired: number;
    readonly removedTaskFiles: ReadonlyArray<string>;
    readonly dryRun: boolean;
}

const STALE_SELECT = (days: number): string =>
    `SELECT id, title, dedupe_sig, form, type::string(updated_at) AS updated_at
FROM proposal
WHERE status = 'open'
  AND (updated_at IS NONE OR updated_at < time::now() - ${days}d)
  AND created_at < time::now() - ${days}d;`;

export const buildExpireStatement = (days: number): string =>
    `UPDATE proposal SET
    status = 'superseded',
    reject_reason = 'housekeeping: signal not re-observed in ${days}d - re-mined automatically if it recurs',
    updated_at = time::now()
WHERE status = 'open'
  AND (updated_at IS NONE OR updated_at < time::now() - ${days}d)
  AND created_at < time::now() - ${days}d;`;

export const findStaleOpenProposals = Effect.fn("improve.findStaleOpenProposals")(
    function* (days: number) {
        const db = yield* SurrealClient;
        const result = yield* db.query<[StaleProposalRow[]]>(STALE_SELECT(days));
        return result[0] ?? [];
    },
);

/** Task-brief files older than the window. Bun-only - no node:fs (repo gate). */
const staleTaskFiles = async (dir: string, days: number): Promise<string[]> => {
    const cutoff = Date.now() - days * 86_400_000;
    const glob = new Bun.Glob("*.md");
    const stale: string[] = [];
    try {
        for await (const name of glob.scan({ cwd: dir, absolute: false })) {
            const file = Bun.file(`${dir}/${name}`);
            if ((await file.exists()) && file.lastModified < cutoff) {
                stale.push(`${dir}/${name}`);
            }
        }
    } catch {
        /* no .ax/tasks dir - nothing to sweep */
    }
    return stale;
};

export const runHousekeep = Effect.fn("improve.runHousekeep")(function* (opts: {
    readonly days: number;
    readonly dryRun: boolean;
    readonly taskDir?: string;
}) {
    const taskDir = opts.taskDir ?? ".ax/tasks";
    const staleProposals = yield* findStaleOpenProposals(opts.days);
    const staleFiles = yield* Effect.tryPromise(() => staleTaskFiles(taskDir, opts.days));

    if (opts.dryRun) {
        return {
            staleProposals,
            expired: 0,
            removedTaskFiles: staleFiles,
            dryRun: true,
        } satisfies HousekeepReport;
    }

    if (staleProposals.length > 0) {
        const db = yield* SurrealClient;
        yield* db.query(buildExpireStatement(opts.days));
    }
    const removed: string[] = [];
    for (const path of staleFiles) {
        // Bun.file.delete() removes the file; ignore races.
        yield* Effect.tryPromise(async () => {
            try {
                await Bun.file(path).delete();
                removed.push(path);
            } catch {
                /* already gone */
            }
        });
    }
    return {
        staleProposals,
        expired: staleProposals.length,
        removedTaskFiles: removed,
        dryRun: false,
    } satisfies HousekeepReport;
});
