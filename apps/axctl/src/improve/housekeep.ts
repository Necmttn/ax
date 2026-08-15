import { Effect, Schema } from "effect";
import { Judgment, TextColumn, TimestampColumn } from "@ax/lib/sqlite";

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

const staleCutoff = (days: number): Date => new Date(Date.now() - days * 86_400_000);

export const buildExpireStatement = (days: number): string =>
    `UPDATE proposal SET
    status = 'superseded',
    reject_reason = 'housekeeping: signal not re-observed in ${days}d - re-mined automatically if it recurs',
    updated_at = ?
WHERE status = 'open'
  AND (updated_at IS NULL OR updated_at < ?)
  AND created_at < ?`;

export const findStaleOpenProposals = Effect.fn("improve.findStaleOpenProposals")(
    function* (days: number) {
        const judgment = yield* Judgment;
        const cutoff = staleCutoff(days);
        const rows = yield* judgment.rows(
            Schema.Struct({
                id: TextColumn,
                title: TextColumn,
                dedupe_sig: TextColumn,
                form: TextColumn,
                updated_at: Schema.NullOr(TimestampColumn),
            }),
            `SELECT id, title, dedupe_sig, form, updated_at
             FROM proposal
             WHERE status = 'open'
               AND (updated_at IS NULL OR updated_at < ?)
               AND created_at < ?`,
            [cutoff, cutoff],
        );
        return rows.map((row) => ({ ...row, updated_at: row.updated_at?.toISOString() ?? null }));
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
        const judgment = yield* Judgment;
        const now = new Date();
        const cutoff = staleCutoff(opts.days);
        yield* judgment.exec(buildExpireStatement(opts.days), [now, cutoff, cutoff]);
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
