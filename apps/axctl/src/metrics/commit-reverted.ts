import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { recordLiteral, stableDigest } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { deriveClosureRows } from "../ingest/closure.ts";

const WATERMARK_SOURCE = "metrics:commit_reverted";
const WATERMARK_PATH = "__commit_reverted__";
const watermarkId = (): string =>
    recordLiteral("ingest_file_state", stableDigest(`${WATERMARK_SOURCE}|${WATERMARK_PATH}`));

export interface RevertedResult {
    readonly revertedCount: number;
    readonly totalCommits: number;
    /** Commit keys whose `reverted` flag flipped this run (BOTH true→false and
     *  false→true). The caller recomputes sessions that produced any of these,
     *  so a true→false flip un-stales the old session's durability. */
    readonly changedKeys: readonly string[];
    /** True when the commit graph was unchanged since last run and the
     *  full-history scan was skipped. */
    readonly skipped: boolean;
    /** The commit-graph fingerprint for this run. The CALLER advances the
     *  watermark (via {@link advanceRevertedWatermark}) only AFTER the dependent
     *  session_metrics rows are written, so a crash between the reverted writes
     *  and the rollup leaves the watermark stale → the next run re-scans and
     *  re-derives the affected sessions instead of silently skipping them. */
    readonly fingerprint: string;
}

/** Advance the commit-reverted watermark. Call only after the dependent
 *  session_metrics rows for this run's `changedKeys` have been written. */
export const advanceRevertedWatermark = (fingerprint: string): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(
            db,
            [
                `UPSERT ${watermarkId()} CONTENT { path: ${surrealString(WATERMARK_PATH)},`
                + ` source_kind: ${surrealString(WATERMARK_SOURCE)}, sha: ${surrealString(fingerprint)},`
                + ` ingested_at: time::now() };`,
            ],
            { chunkSize: 1 },
        );
    });

/**
 * Compute `commit.reverted` over FULL history (freshness backbone, ADR-0011).
 *
 * Reuses closure's pure {@link deriveClosureRows} fix-chain detection rather
 * than reading the window-truncated `later_fixed_by` edge (closure rebuilds that
 * edge window-bounded, so it gives stale forward-looking numbers when a NEW fix
 * lands for an OLD feature commit).
 *
 * Two cost controls keep this safe on the live `--since=1` daemon path, where
 * the stage now runs by default:
 *  1. **Watermark skip** - a cheap `(commit count, max ts, touched count)`
 *     fingerprint is compared to the last run's; when unchanged we skip the
 *     full-history load + re-derivation entirely (mirrors closure's watermark).
 *     `AX_REDERIVE_METRICS=1` forces a re-derive (e.g. after a logic change).
 *  2. **Diff-only writes** - only the commits whose `reverted` flips are
 *     UPDATEd, by primary id (never a full-table reset, never `WHERE reverted`
 *     which hits a SurrealDB index-drift footgun).
 */
export const computeRevertedCommits = (): Effect.Effect<RevertedResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Cheap fingerprint - skip the full-history scan when nothing moved.
        const commitFp = (yield* db.query<[Array<{ c?: number; m?: string | null }>]>(
            `SELECT count() AS c, type::string(math::max(ts)) AS m FROM commit GROUP ALL;`,
        ))?.[0]?.[0];
        const touchedFp = (yield* db.query<[Array<{ c?: number }>]>(
            `SELECT count() AS c FROM touched GROUP ALL;`,
        ))?.[0]?.[0];
        const totalCommits = Number(commitFp?.c ?? 0);
        const fingerprint = stableDigest(`${totalCommits}|${commitFp?.m ?? ""}|${Number(touchedFp?.c ?? 0)}`, 32);
        const stored = (yield* db.query<[Array<{ sha?: string }>]>(
            `SELECT sha FROM ingest_file_state WHERE source_kind = ${surrealString(WATERMARK_SOURCE)};`,
        ))?.[0]?.[0]?.sha;
        const forced = process.env.AX_REDERIVE_METRICS === "1";
        if (!forced && typeof stored === "string" && stored === fingerprint) {
            const cur = (yield* db.query<[Array<{ n?: number }>]>(
                `SELECT count() AS n FROM commit WHERE reverted = true GROUP ALL;`,
            ))?.[0]?.[0]?.n ?? 0;
            return { revertedCount: Number(cur), totalCommits, changedKeys: [], skipped: true, fingerprint };
        }

        // 2. Full-history re-derivation (only when the graph changed).
        const commits = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, message, repository, type::string(ts) AS ts FROM commit ORDER BY ts ASC;`,
        ))?.[0] ?? [];
        const touched = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT in, out, out.path AS path FROM touched;`,
        ))?.[0] ?? [];
        const rows = deriveClosureRows({
            commits: commits as never,
            touched: touched as never,
            // sessionHealth is unused by the fix-chain path; passed empty only to
            // satisfy deriveClosureRows' shared input shape.
            sessionHealth: [],
        });
        const revertedKeys = new Set(rows.fixChains.map((c) => c.featureKey));

        const existingRaw = (yield* db.query<[Array<string>]>(
            `SELECT VALUE type::string(id) FROM commit WHERE reverted = true;`,
        ))?.[0] ?? [];
        const existing = new Set(
            existingRaw.map((id) => recordKeyPart(id, "commit")).filter((k): k is string => k !== null),
        );

        // 3. Diff-only writes + collect the changed keys (both directions).
        const stmts: string[] = [];
        const changedKeys: string[] = [];
        for (const k of revertedKeys) {
            if (!existing.has(k)) {
                stmts.push(`UPDATE ${recordLiteral("commit", k)} SET reverted = true;`);
                changedKeys.push(k);
            }
        }
        for (const k of existing) {
            if (!revertedKeys.has(k)) {
                stmts.push(`UPDATE ${recordLiteral("commit", k)} SET reverted = false;`);
                changedKeys.push(k);
            }
        }
        if (stmts.length > 0) yield* executeStatementsWith(db, stmts, { chunkSize: 500 });

        // NOTE: the watermark is advanced by the CALLER (derive-metrics) only
        // after the dependent session_metrics rows are written - not here - so a
        // crash between these reverted writes and the rollup re-scans next run.
        return { revertedCount: revertedKeys.size, totalCommits: commits.length, changedKeys, skipped: false, fingerprint };
    });
