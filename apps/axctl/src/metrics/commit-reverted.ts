import { Effect, Option, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { stableDigest } from "@ax/lib/ids";
import { deriveClosureRows } from "../ingest/closure.ts";

const WATERMARK_SOURCE = "metrics:commit_reverted";
const WATERMARK_PATH = "__commit_reverted__";

const FingerprintRow = Schema.Struct({
    count: NumberFromBigIntColumn,
    latest: Schema.NullOr(TimestampColumn),
});
const CountRow = Schema.Struct({ count: NumberFromBigIntColumn });
const StoredRow = Schema.Struct({ sha: Schema.NullOr(Schema.String) });
const CommitRow = Schema.Struct({
    id: Schema.String,
    message: Schema.NullOr(Schema.String),
    repository: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});
const TouchedRow = Schema.Struct({
    commit: Schema.String,
    path: Schema.String,
});
const IdRow = Schema.Struct({ id: Schema.String });

export interface RevertedResult {
    readonly revertedCount: number;
    readonly totalCommits: number;
    readonly changedKeys: readonly string[];
    readonly skipped: boolean;
    readonly fingerprint: string;
}

/** Advance this mark only after the dependent metric rows succeed. */
export const advanceRevertedWatermark = (
    write: CacheWriteService,
    fingerprint: string,
): Effect.Effect<void, CacheWriteError> =>
    write.put(WATERMARK_TABLE, watermarkRow(WATERMARK_SOURCE, WATERMARK_PATH, { sha: fingerprint }));

/** Recompute the full commit fix-chain state on the live ingest connection. */
export const computeRevertedCommits = (
    write: CacheWriteService,
): Effect.Effect<RevertedResult, CacheWriteError> =>
    Effect.gen(function* () {
        const commitFp = yield* write.first(
            FingerprintRow,
            `SELECT count(*) AS count, max(ts) AS latest FROM "commit"`,
        );
        const touchedFp = yield* write.first(CountRow, `SELECT count(*) AS count FROM touched`);
        const totalCommits = Option.isSome(commitFp) ? commitFp.value.count : 0;
        const latest = Option.isSome(commitFp) && commitFp.value.latest !== null
            ? commitFp.value.latest.toISOString()
            : "";
        const touchedCount = Option.isSome(touchedFp) ? touchedFp.value.count : 0;
        const fingerprint = stableDigest(`${totalCommits}|${latest}|${touchedCount}`, 32);

        const stored = yield* write.first(
            StoredRow,
            `SELECT sha FROM ingest_file_state WHERE source_kind = ? AND path = ? LIMIT 1`,
            [WATERMARK_SOURCE, WATERMARK_PATH],
        );
        if (
            process.env.AX_REDERIVE_METRICS !== "1"
            && Option.isSome(stored)
            && stored.value.sha === fingerprint
        ) {
            const current = yield* write.first(
                CountRow,
                `SELECT count(*) AS count FROM "commit" WHERE reverted = true`,
            );
            return {
                revertedCount: Option.isSome(current) ? current.value.count : 0,
                totalCommits,
                changedKeys: [],
                skipped: true,
                fingerprint,
            };
        }

        const commits = yield* write.rows(
            CommitRow,
            `SELECT id, message, repository, ts FROM "commit" ORDER BY ts ASC`,
        );
        const touched = yield* write.rows(
            TouchedRow,
            `SELECT t.in_id AS commit, f.path AS path FROM touched t JOIN file f ON f.id = t.out_id`,
        );
        const rows = deriveClosureRows({
            commits: commits.map((row) => ({
                id: `commit:${row.id}`,
                ...(row.message === null ? {} : { message: row.message }),
                ...(row.repository === null ? {} : { repository: `repository:${row.repository}` }),
                ts: row.ts,
            })),
            touched: touched.map((row) => ({ in: `commit:${row.commit}`, path: row.path })),
            sessionHealth: [],
        });
        const revertedKeys = new Set(rows.fixChains.map((chain) => chain.featureKey));
        const existing = new Set(
            (yield* write.rows(IdRow, `SELECT id FROM "commit" WHERE reverted = true`)).map((row) => row.id),
        );
        const changedKeys: string[] = [];
        for (const key of revertedKeys) {
            if (existing.has(key)) continue;
            yield* write.exec(`UPDATE "commit" SET reverted = true WHERE id = ?`, [key]);
            changedKeys.push(key);
        }
        for (const key of existing) {
            if (revertedKeys.has(key)) continue;
            yield* write.exec(`UPDATE "commit" SET reverted = false WHERE id = ?`, [key]);
            changedKeys.push(key);
        }

        return {
            revertedCount: revertedKeys.size,
            totalCommits: commits.length,
            changedKeys,
            skipped: false,
            fingerprint,
        };
    });
