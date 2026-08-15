import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { inClause } from "@ax/lib/duckdb/clause";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { WATERMARK_TABLE, watermarkRow, watermarkRowId } from "@ax/lib/duckdb/watermark";

const WATERMARK_SOURCE = "metrics:pr_merge";
const PATH_PREFIX = "__pr_merge__/";

const PullRequestRow = Schema.Struct({
    id: Schema.String,
    merge_sha: Schema.NullOr(Schema.String),
    merged_at: Schema.NullOr(TimestampColumn),
});
const StoredRow = Schema.Struct({ path: Schema.String, sha: Schema.NullOr(Schema.String) });
const CommitRow = Schema.Struct({ id: Schema.String, sha: Schema.String });
const SessionRow = Schema.Struct({ session: Schema.String });

export const prMergeWatermarkPath = (prKey: string): string => `${PATH_PREFIX}${prKey}`;

export const encodePrMergeState = (mergeSha: string | null, mergedAt: string | null): string =>
    `${mergeSha ?? ""}|${mergedAt ?? ""}`;

export const mergeShaOfEncoded = (encoded: string): string | null => {
    const index = encoded.indexOf("|");
    const sha = index === -1 ? encoded : encoded.slice(0, index);
    return sha.length > 0 ? sha : null;
};

export interface PrMergeDiff {
    readonly changedShas: readonly string[];
    readonly upserts: ReadonlyArray<{ readonly prKey: string; readonly encoded: string }>;
    readonly deletes: readonly string[];
}

export const diffPrMergeStates = (
    stored: ReadonlyMap<string, string>,
    current: ReadonlyMap<string, string>,
): PrMergeDiff => {
    const changed = new Set<string>();
    const upserts: Array<{ prKey: string; encoded: string }> = [];
    const deletes: string[] = [];
    for (const [prKey, encoded] of current) {
        const previous = stored.get(prKey);
        if (previous === encoded) continue;
        upserts.push({ prKey, encoded });
        const newSha = mergeShaOfEncoded(encoded);
        const oldSha = previous === undefined ? null : mergeShaOfEncoded(previous);
        if (newSha !== null) changed.add(newSha);
        if (oldSha !== null) changed.add(oldSha);
    }
    for (const [prKey, encoded] of stored) {
        if (current.has(prKey)) continue;
        deletes.push(prKey);
        const oldSha = mergeShaOfEncoded(encoded);
        if (oldSha !== null) changed.add(oldSha);
    }
    return { changedShas: [...changed], upserts, deletes };
};

export interface PrMergeDirtyResult {
    readonly dirtySessionIds: readonly string[];
    readonly changedPrs: number;
    readonly skipped: boolean;
    readonly diff: PrMergeDiff;
    readonly deferredPrs: number;
}

export const computePrMergeDirtySessions = (
    write: CacheWriteService,
): Effect.Effect<PrMergeDirtyResult, CacheWriteError> =>
    Effect.gen(function* () {
        const prRows = yield* write.rows(
            PullRequestRow,
            `SELECT id, merge_sha, merged_at FROM pull_request`
                + ` WHERE merge_sha IS NOT NULL OR merged_at IS NOT NULL`,
        );
        const current = new Map<string, string>();
        for (const row of prRows) {
            current.set(row.id, encodePrMergeState(row.merge_sha, row.merged_at?.toISOString() ?? null));
        }

        const stored = new Map<string, string>();
        if (process.env.AX_REDERIVE_METRICS !== "1") {
            const rows = yield* write.rows(
                StoredRow,
                `SELECT path, sha FROM ingest_file_state WHERE source_kind = ?`,
                [WATERMARK_SOURCE],
            );
            for (const row of rows) {
                if (!row.path.startsWith(PATH_PREFIX) || row.sha === null) continue;
                stored.set(row.path.slice(PATH_PREFIX.length), row.sha);
            }
        }

        const diff = diffPrMergeStates(stored, current);
        const changedPrs = diff.upserts.length + diff.deletes.length;
        if (diff.changedShas.length === 0) {
            return { dirtySessionIds: [], changedPrs, skipped: changedPrs === 0, diff, deferredPrs: 0 };
        }

        const shaClause = inClause("sha", diff.changedShas);
        const commits = yield* write.rows(
            CommitRow,
            `SELECT id, sha FROM "commit" WHERE ${shaClause.sql}`,
            shaClause.params,
        );
        const resolvedShas = new Set(commits.map((row) => row.sha));
        const commitClause = inClause("out_id", commits.map((row) => row.id));
        const sessions = commits.length === 0
            ? []
            : yield* write.rows(
                SessionRow,
                `SELECT DISTINCT in_id AS session FROM produced WHERE ${commitClause.sql}`,
                commitClause.params,
            );

        const upserts = diff.upserts.filter(({ encoded }) => {
            const sha = mergeShaOfEncoded(encoded);
            return sha === null || resolvedShas.has(sha);
        });
        return {
            dirtySessionIds: sessions.map((row) => row.session),
            changedPrs,
            skipped: false,
            diff: { changedShas: diff.changedShas, upserts, deletes: diff.deletes },
            deferredPrs: diff.upserts.length - upserts.length,
        };
    });

/** Persist the PR snapshot after dependent metric rows succeed. */
export const advancePrMergeWatermark = (
    write: CacheWriteService,
    diff: PrMergeDiff,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        if (diff.upserts.length > 0) {
            yield* write.putMany(
                WATERMARK_TABLE,
                diff.upserts.map(({ prKey, encoded }) =>
                    watermarkRow(WATERMARK_SOURCE, prMergeWatermarkPath(prKey), { sha: encoded })),
            );
        }
        if (diff.deletes.length > 0) {
            const ids = diff.deletes.map((prKey) =>
                watermarkRowId(WATERMARK_SOURCE, prMergeWatermarkPath(prKey)),
            );
            const clause = inClause("id", ids);
            yield* write.exec(`DELETE FROM ingest_file_state WHERE ${clause.sql}`, clause.params);
        }
    });
