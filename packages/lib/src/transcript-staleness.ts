/**
 * Detect new transcript files for a Claude project slug that haven't been
 * ingested yet. Used by `ax sessions here|near` (P1.4): when the DB lags
 * behind on-disk transcripts, the command can auto-backfill (small delta)
 * or warn the user (large delta) instead of silently returning stale rows.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "./db.ts";
import type { DbError } from "./errors.ts";

export interface StalenessReport {
    /** Absolute paths of jsonl files on disk that have no matching session.raw_file row. */
    readonly newFiles: ReadonlyArray<string>;
    /** Total .jsonl files in the project transcript dir. */
    readonly totalOnDisk: number;
    /** Total sessions in the DB for this project slug with a non-NONE raw_file. */
    readonly totalInDb: number;
}

/**
 * Compare on-disk transcripts vs DB session rows for a given Claude project
 * slug. Returns the list of jsonl files that the DB doesn't know about yet.
 *
 * - `transcriptsDir`: root path (e.g. ~/.claude/projects).
 * - `project`: encoded slug (e.g. -Users-necmttn-Projects-ax).
 */
export const detectStaleness = (opts: {
    readonly transcriptsDir: string;
    readonly project: string;
}): Effect.Effect<StalenessReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const projectDir = join(opts.transcriptsDir, opts.project);

        const onDisk = yield* Effect.promise(async () => {
            try {
                const entries = await readdir(projectDir);
                return entries
                    .filter((e) => e.endsWith(".jsonl"))
                    .map((e) => join(projectDir, e));
            } catch {
                return [] as string[];
            }
        });

        const rows = yield* db.query<[Array<{ raw_file: unknown }>]>(
            `SELECT raw_file FROM session
             WHERE project = $project AND raw_file IS NOT NONE;`,
            { project: opts.project },
        );

        // Build a set of bare filenames the DB has seen. `raw_file` is stored
        // either as the original absolute path or as a bucket pointer like
        // `transcripts:/<id>.jsonl` - compare on basename to be robust.
        const seenBasenames = new Set<string>();
        for (const row of rows?.[0] ?? []) {
            const v = row.raw_file;
            if (typeof v !== "string" || v.length === 0) continue;
            const base = v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : v;
            seenBasenames.add(base);
        }

        const newFiles = onDisk.filter((p) => {
            const base = p.slice(p.lastIndexOf("/") + 1);
            return !seenBasenames.has(base);
        });

        return {
            newFiles,
            totalOnDisk: onDisk.length,
            totalInDb: seenBasenames.size,
        };
    });
