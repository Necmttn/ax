/**
 * watermark: the shared seam for the per-file "skip-unchanged" fingerprint that
 * ingest stages record after a successful derive. It is the IDEMPOTENCY-STATE
 * counterpart in the shared-seam family: `surql.ts` formats literals,
 * `statement-exec.ts` executes statement batches, `graph-query.ts` runs typed
 * reads - and this module owns the one read + one UPSERT that let a stage skip
 * an input whose `(mtime,size)` still matches its stored mark.
 *
 * Two ingest stages (`transcripts.ts` over `claude_transcript`,
 * `derive-claude-subagents.ts` over `claude_subagent`) carried byte-identical
 * copies of this pattern. They now both build a {@link FileWatermark} value
 * object: ONE indexed read loads the whole mark Map up front, `unchanged()` is
 * a pure in-memory lookup the stage's own loop uses to skip, and `commit()`
 * UPSERTs the mark - called by the stage only AFTER the file's writes succeed,
 * so a mid-file failure re-processes next run (a load-bearing ordering the
 * caller keeps).
 *
 * This is a value-object factory, NOT a combinator: the stage keeps its own
 * loop / concurrency / counters. The seam owns only the watermark read+write
 * and the single id scheme.
 */

import { Effect } from "effect";
import { SurrealClient } from "../db.ts";
import type { DbError } from "../errors.ts";
import { recordLiteral, stableDigest } from "../ids.ts";
import { executeStatementsWith } from "./statement-exec.ts";
import { surrealString } from "./surql.ts";

const WATERMARK_TABLE = "ingest_file_state";

/** Source kinds whose watermark rows the id-unify migration clean-slates. */
const MIGRATED_SOURCE_KINDS = ["claude_transcript", "claude_subagent"] as const;

/** Sentinel marker recorded once after the id-unify clean-slate runs. */
const MIGRATION_SENTINEL_SOURCE_KIND = "__watermark_migration__";
const MIGRATION_SENTINEL_KEY = "id-unify-v1";

/**
 * The watermark record id for a `(sourceKind, path)` pair. ONE scheme for every
 * source kind: `stableDigest("<sourceKind>|<path>")`. This unifies the two
 * pre-seam derivations (transcripts hashed the bare path; subagents hashed it a
 * different way) so the same logical file maps to exactly one row.
 *
 * Exported for the metrics watermarks (`commit-reverted.ts`,
 * `pr-merge-dirty.ts`, `fragility-cascade.ts`), which store their dirty-set
 * fingerprints in the same `ingest_file_state` table and must share this id
 * scheme rather than hand-roll the digest.
 */
export const watermarkRecordKey = (sourceKind: string, path: string): string =>
    stableDigest(`${sourceKind}|${path}`);

export interface FileWatermark {
    /** true ⇒ on-disk (mtime,size) matches the stored mark ⇒ caller should skip. */
    unchanged(path: string, mtimeMs: number, size: number): boolean;
    /** UPSERT the mark. Call only AFTER the file's writes succeed. */
    commit(path: string, mtimeMs: number, size: number): Effect.Effect<void, DbError>;
}

export interface FileWatermarkConfig {
    /** The `source_kind` column these watermarks are stored under, e.g. "claude_transcript". */
    readonly sourceKind: string;
    /** Env var whose value "1" forces a full re-derive (empty mark Map), e.g. "AX_REDERIVE_CLAUDE". */
    readonly forceEnv: string;
}

/**
 * Load the watermark Map for a source kind in ONE indexed read and hand back a
 * {@link FileWatermark} value object. Honors `cfg.forceEnv === "1"` by building
 * an EMPTY map (so every `unchanged()` returns false ⇒ a full re-derive).
 *
 * For the two source kinds whose id scheme changed (transcripts + subagents)
 * this also runs the one-time id-unify clean-slate before reading, guarded by a
 * sentinel row so it executes at most once ever (see {@link ensureWatermarkIdMigration}).
 */
export const fileWatermark = (
    cfg: FileWatermarkConfig,
): Effect.Effect<FileWatermark, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // Clean-slate legacy rows ONCE before loading, only for the migrated
        // kinds, so the changed id scheme can't leave same-path duplicates.
        if ((MIGRATED_SOURCE_KINDS as readonly string[]).includes(cfg.sourceKind)) {
            yield* ensureWatermarkIdMigration;
        }

        const forceRederive = process.env[cfg.forceEnv] === "1";
        const fileStateRows = (yield* db.query<[Array<{ path?: string; mtime_ms?: number; size?: number }>]>(
            `SELECT path, mtime_ms, size FROM ${WATERMARK_TABLE} WHERE source_kind = ${surrealString(cfg.sourceKind)};`,
        ))?.[0] ?? [];
        const marks = new Map<string, { mtimeMs: number; size: number }>();
        if (!forceRederive) {
            for (const row of fileStateRows) {
                if (
                    typeof row.path === "string" &&
                    typeof row.mtime_ms === "number" &&
                    typeof row.size === "number"
                ) {
                    marks.set(row.path, { mtimeMs: row.mtime_ms, size: row.size });
                }
            }
        }

        return {
            unchanged: (path, mtimeMs, size) => {
                const mark = marks.get(path);
                return !!mark && mark.mtimeMs === mtimeMs && mark.size === size;
            },
            commit: (path, mtimeMs, size) =>
                executeStatementsWith(
                    db,
                    [
                        `UPSERT ${recordLiteral(WATERMARK_TABLE, watermarkRecordKey(cfg.sourceKind, path))} CONTENT { path: ${surrealString(path)}, source_kind: ${surrealString(cfg.sourceKind)}, mtime_ms: ${Math.trunc(mtimeMs)}, size: ${Math.trunc(size)}, ingested_at: time::now() };`,
                    ],
                    { chunkSize: 1 },
                ),
        } satisfies FileWatermark;
    });

/**
 * One-time clean-slate for the unified watermark id scheme. Because the record
 * id derivation changed, the old per-path rows would collide as same-`path`
 * duplicates under the new ids - a real stale-read bug. So the first time this
 * runs we DELETE every `claude_transcript`/`claude_subagent` watermark and drop
 * a sentinel row; subsequent runs see the sentinel and no-op. The DELETE is
 * scoped to exactly those two kinds, never touching git_repo / pricing /
 * closure / etc. Idempotent.
 */
export const ensureWatermarkIdMigration: Effect.Effect<void, DbError, SurrealClient> =
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sentinelRows = (yield* db.query<[Array<unknown>]>(
            `SELECT id FROM ${WATERMARK_TABLE} WHERE source_kind = ${surrealString(MIGRATION_SENTINEL_SOURCE_KIND)};`,
        ))?.[0] ?? [];
        if (sentinelRows.length > 0) return;

        const kinds = MIGRATED_SOURCE_KINDS.map((k) => surrealString(k)).join(", ");
        yield* executeStatementsWith(
            db,
            [
                `DELETE ${WATERMARK_TABLE} WHERE source_kind IN [${kinds}];`,
                `UPSERT ${recordLiteral(WATERMARK_TABLE, watermarkRecordKey(MIGRATION_SENTINEL_SOURCE_KIND, MIGRATION_SENTINEL_KEY))} CONTENT { path: ${surrealString(MIGRATION_SENTINEL_KEY)}, source_kind: ${surrealString(MIGRATION_SENTINEL_SOURCE_KIND)}, ingested_at: time::now() };`,
            ],
            { chunkSize: 1 },
        );
    });
