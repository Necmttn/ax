import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { recordLiteral, stableDigest } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";

/**
 * PR-driven dirty source for derive-metrics (issue #172).
 *
 * Problem: on the daemon's `--since=1` path, `time_to_land_ms` stays stale/NULL
 * for an OLD session whose PR merges LATER - the dirty set keyed on the time
 * window + changed `commit.reverted` + spawn-parents, but never on PR changes.
 *
 * Fix: mirror the commit-reverted watermark (`commit-reverted.ts`), but
 * per-PR. Each merged-state PR gets one `ingest_file_state` row
 * (source_kind `metrics:pr_merge`, path `__pr_merge__/<prKey>`) whose `sha`
 * column stores the RAW `"<merge_sha>|<merged_at>"` pair - raw, not digested,
 * so a changed/removed PR can still dirty the sessions that produced its OLD
 * merge commit. Diffing the stored snapshot against the current
 * `pull_request` rows yields the merge shas that changed since the last
 * github-pr ingest; those map (sha → commit → produced.in) to the sessions
 * whose `time_to_land_ms` must re-derive.
 *
 * Crash-safety ordering mirrors commit-reverted: the CALLER (derive-metrics)
 * advances the watermark via {@link advancePrMergeWatermark} only AFTER the
 * dependent session_metrics rows are written, so a crash in between re-diffs
 * and re-derives next run instead of silently skipping.
 *
 * Hang-safety: every query is a single bounded set read - the `pull_request`
 * and watermark tables are small (gh fetch caps at 200/repo), and the
 * sha→commit→session resolution is chunked IN-lists over indexed fields
 * (`commit.sha` via commit_sha_uq, `produced.out`). No per-edge derefs.
 */

const WATERMARK_SOURCE = "metrics:pr_merge";
const PATH_PREFIX = "__pr_merge__/";

/** The `ingest_file_state.path` for a PR's merge-state watermark row. */
export const prMergeWatermarkPath = (prKey: string): string => `${PATH_PREFIX}${prKey}`;

/** Deterministic watermark row id - same scheme as `@ax/lib/shared/watermark`. */
const watermarkRowId = (prKey: string): string =>
    recordLiteral("ingest_file_state", stableDigest(`${WATERMARK_SOURCE}|${prMergeWatermarkPath(prKey)}`));

/**
 * Encode a PR's merge state as the watermark `sha` payload. The merge sha is
 * kept RAW (not digested) so the OLD sha of a changed/removed PR is
 * recoverable at diff time.
 */
export const encodePrMergeState = (mergeSha: string | null, mergedAt: string | null): string =>
    `${mergeSha ?? ""}|${mergedAt ?? ""}`;

/** Extract the merge sha back out of an encoded `"<sha>|<mergedAt>"` payload. */
export const mergeShaOfEncoded = (encoded: string): string | null => {
    const idx = encoded.indexOf("|");
    const sha = idx === -1 ? encoded : encoded.slice(0, idx);
    return sha.length > 0 ? sha : null;
};

export interface PrMergeDiff {
    /** Merge shas affected by PR changes since the last run - the union of
     *  NEW shas (PR merged / merge_sha changed) and OLD shas (previous value of
     *  a changed PR, or a PR whose merge state disappeared). */
    readonly changedShas: readonly string[];
    /** Watermark rows to UPSERT once the dependent metrics are written. */
    readonly upserts: ReadonlyArray<{ readonly prKey: string; readonly encoded: string }>;
    /** prKeys whose watermark row should be deleted (PR lost its merge state). */
    readonly deletes: readonly string[];
}

/**
 * Pure diff between the stored watermark snapshot and the current
 * `pull_request` merge states (both keyed by PR record key, valued by
 * {@link encodePrMergeState} payloads).
 */
export const diffPrMergeStates = (
    stored: ReadonlyMap<string, string>,
    current: ReadonlyMap<string, string>,
): PrMergeDiff => {
    const changed = new Set<string>();
    const upserts: Array<{ prKey: string; encoded: string }> = [];
    const deletes: string[] = [];

    for (const [prKey, encoded] of current) {
        const prev = stored.get(prKey);
        if (prev === encoded) continue;
        upserts.push({ prKey, encoded });
        const newSha = mergeShaOfEncoded(encoded);
        if (newSha !== null) changed.add(newSha);
        if (prev !== undefined) {
            const oldSha = mergeShaOfEncoded(prev);
            if (oldSha !== null) changed.add(oldSha);
        }
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
    /** Sessions (as `type::string(id)` strings) producing a commit whose PR
     *  merge state changed since the last run - merge into the dirty set. */
    readonly dirtySessionIds: readonly string[];
    /** Number of PRs whose merge state changed (upserts + deletes). */
    readonly changedPrs: number;
    /** True when no PR merge state changed - nothing to advance. */
    readonly skipped: boolean;
    /** The diff for {@link advancePrMergeWatermark}. The CALLER advances only
     *  AFTER the dependent session_metrics rows are written. */
    readonly diff: PrMergeDiff;
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
    return out;
};

/**
 * Compute the PR-driven dirty sessions: diff the stored per-PR merge-state
 * watermark against the current `pull_request` rows, then resolve the changed
 * merge shas to the sessions that produced the matching commits.
 *
 * `AX_REDERIVE_METRICS=1` forces the diff against an EMPTY snapshot (every
 * merged PR counts as changed), mirroring the commit-reverted force semantics.
 */
export const computePrMergeDirtySessions = (): Effect.Effect<PrMergeDirtyResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Current snapshot - only PRs with any merge state matter for
        //    time_to_land; unmerged PRs that LOSE state are caught via `stored`.
        const prRows = (yield* db.query<[Array<{ id?: string; merge_sha?: string | null; merged_at?: string | null }>]>(
            `SELECT type::string(id) AS id, merge_sha, type::string(merged_at) AS merged_at FROM pull_request WHERE merge_sha != NONE OR merged_at != NONE;`,
        ))?.[0] ?? [];
        const current = new Map<string, string>();
        for (const row of prRows) {
            const prKey = typeof row.id === "string" ? recordKeyPart(row.id, "pull_request") : null;
            if (prKey === null || prKey === undefined) continue;
            current.set(prKey, encodePrMergeState(
                typeof row.merge_sha === "string" ? row.merge_sha : null,
                typeof row.merged_at === "string" ? row.merged_at : null,
            ));
        }

        // 2. Stored snapshot (one indexed read over the source_kind).
        const forced = process.env.AX_REDERIVE_METRICS === "1";
        const stored = new Map<string, string>();
        if (!forced) {
            const storedRows = (yield* db.query<[Array<{ path?: string; sha?: string | null }>]>(
                `SELECT path, sha FROM ingest_file_state WHERE source_kind = ${surrealString(WATERMARK_SOURCE)};`,
            ))?.[0] ?? [];
            for (const row of storedRows) {
                if (typeof row.path !== "string" || !row.path.startsWith(PATH_PREFIX)) continue;
                if (typeof row.sha !== "string") continue;
                stored.set(row.path.slice(PATH_PREFIX.length), row.sha);
            }
        }

        // 3. Diff → changed merge shas.
        const diff = diffPrMergeStates(stored, current);
        const changedPrs = diff.upserts.length + diff.deletes.length;
        if (diff.changedShas.length === 0) {
            return { dirtySessionIds: [], changedPrs, skipped: changedPrs === 0, diff };
        }

        // 4. Resolve changed shas → commits → producing sessions. Chunked
        //    IN-lists over indexed fields; bounded by the changed-PR count.
        const dirty = new Set<string>();
        for (const shas of chunk(diff.changedShas, 200)) {
            const shaList = shas.map((s) => surrealString(s)).join(", ");
            const commitIds = (yield* db.query<[string[]]>(
                `SELECT VALUE type::string(id) FROM commit WHERE sha IN [${shaList}];`,
            ))?.[0] ?? [];
            const commitRefs = commitIds
                .map((id) => (typeof id === "string" ? recordKeyPart(id, "commit") : null))
                .filter((k): k is string => typeof k === "string" && k.length > 0)
                .map((k) => recordLiteral("commit", k));
            if (commitRefs.length === 0) continue;
            for (const refs of chunk(commitRefs, 200)) {
                const sessions = (yield* db.query<[string[]]>(
                    `SELECT VALUE type::string(in) FROM produced WHERE out IN [${refs.join(", ")}];`,
                ))?.[0] ?? [];
                for (const s of sessions) if (typeof s === "string" && s.length > 0) dirty.add(s);
            }
        }

        return { dirtySessionIds: [...dirty], changedPrs, skipped: false, diff };
    });

/**
 * Persist the diffed watermark rows. Call only AFTER the dependent
 * session_metrics rows for this run's dirty sessions have been written.
 * Deletes go by PRIMARY id - never `DELETE ... WHERE` over an indexed field
 * (SurrealDB ghost-index footgun, see `surreal-delete-where-index-drift`).
 */
export const advancePrMergeWatermark = (diff: PrMergeDiff): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const stmts: string[] = [];
        for (const { prKey, encoded } of diff.upserts) {
            stmts.push(
                `UPSERT ${watermarkRowId(prKey)} CONTENT { path: ${surrealString(prMergeWatermarkPath(prKey))},`
                + ` source_kind: ${surrealString(WATERMARK_SOURCE)}, sha: ${surrealString(encoded)},`
                + ` ingested_at: time::now() };`,
            );
        }
        for (const prKey of diff.deletes) {
            stmts.push(`DELETE ${watermarkRowId(prKey)};`);
        }
        if (stmts.length > 0) yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });
