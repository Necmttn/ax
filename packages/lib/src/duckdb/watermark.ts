/**
 * The ingest watermark: the per-input "skip-unchanged" fingerprint a stage
 * records after a successful derive, and reads on the next run to skip an input
 * that has not moved.
 *
 * ONE ROW SHAPE FOR TEN WRITERS. `ingest_file_state` has never been only about
 * files. Three stages use the (mtime,size) file form through {@link fileWatermark}
 * (claude transcripts, claude subagents, cursor); seven more - git HEAD, model
 * pricing, closure inputs, the github-pr fetch cooldown, and the
 * commit-reverted / pr-merge-dirty / fragility-cascade metrics passes - store a
 * `sha` or a timestamp under a sentinel path, each with its own hand-rolled
 * digest and its own SELECT/UPSERT pair. {@link watermarkRow} is the row shape
 * all of them share, so the id scheme is written down once instead of ten
 * times.
 *
 * WHAT THE PORT DROPS. The Surreal module carried a one-time "id-unify"
 * clean-slate: the record-id derivation had changed, so old rows would have
 * collided as same-`path` duplicates under the new ids, and a sentinel row
 * guarded a one-shot DELETE. None of that comes across. The cache is born empty
 * and every transcript re-ingests, so there are no legacy rows to migrate - the
 * no-backward-compatibility ruling paying for itself in deleted code rather
 * than in ported code.
 *
 * THE `path` UNIQUE INDEX. The DDL carries `UNIQUE (path)` while every writer
 * keys its row by `(source_kind, path)`, so the pair is not actually free: two
 * kinds watermarking ONE path is a constraint violation, not two rows. Nothing
 * does that today - the transcript stage walks `<project>/*.jsonl` while the
 * subagent stage walks `<project>/<id>/subagents/agent-*.jsonl`, and every
 * non-file kind uses its own `__sentinel__` path - and the failure is loud
 * rather than silent, so it is PINNED by a test rather than papered over here.
 * A writer that needs the pair must widen the index.
 *
 * A WATERMARK IS NOT AN OUTPUT. Marks are written only AFTER a file's real
 * writes succeed, so a run that dies mid-file re-processes it next time. That
 * ordering belongs to the caller - this module owns the read and the row, never
 * the loop.
 */
import { Effect, Schema } from "effect";
import { stableId } from "../stable-id.ts";
import { cacheRow, numParam, textParam } from "./row.ts";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "./seam.ts";
import type { DuckDbParam } from "./types.ts";

export const WATERMARK_TABLE = "ingest_file_state";

/**
 * The row id for a `(sourceKind, path)` pair.
 *
 * `stableId` rather than a hand-rolled `digest("<kind>|<path>")`, because its
 * length-prefixed encoding cannot be talked into a collision: the naive
 * separator form hashes `("a|b", "c")` and `("a", "b|c")` to the same string.
 *
 * The absolute path IS the natural key here, which the recipe rules otherwise
 * discourage - a row's identity should not depend on where a checkout lives. It
 * applies to rows that describe SHARED, portable things (a commit, a skill). A
 * watermark is a statement about one file on THIS machine, in a cache that is
 * per-machine and rebuildable from scratch; there is no path-independent
 * identity for it to have.
 */
export const watermarkRowId = (sourceKind: string, path: string): string =>
    stableId(WATERMARK_TABLE, [sourceKind, path]);

/** What a watermark can carry. A stage supplies the fields its own notion of
 *  "unchanged" rests on; the rest of the row is NULL, not absent. */
export interface WatermarkFields {
    readonly mtimeMs?: number | null;
    readonly size?: number | null;
    /** Git HEAD, a content hash, or any other "same input" token. */
    readonly sha?: string | null;
    /** How much history a windowed walk covered, so a widened window re-derives. */
    readonly sinceDays?: number | null;
}

/**
 * One watermark row, ready for `put` / `putMany`.
 *
 * Every field is present on every row (NULL when unsupplied) so that a stage
 * batching many marks into one `putMany` cannot produce a ragged batch, which
 * the seam refuses. `ingested_at` is left to the DDL's `DEFAULT
 * CURRENT_TIMESTAMP` - the seam pins each connection to UTC, so the database's
 * clock is the right one to stamp it.
 */
export const watermarkRow = (
    sourceKind: string,
    path: string,
    fields: WatermarkFields,
): Record<string, DuckDbParam> =>
    cacheRow({
        id: watermarkRowId(sourceKind, path),
        path,
        source_kind: sourceKind,
        mtime_ms: numParam(fields.mtimeMs),
        size: numParam(fields.size),
        sha: textParam(fields.sha),
        since_days: numParam(fields.sinceDays),
    });

export interface FileWatermark {
    /** true => the on-disk (mtime,size) matches the stored mark => skip. */
    unchanged(path: string, mtimeMs: number, size: number): boolean;
    /** Write the mark. Call only AFTER the file's own writes succeed. */
    commit(path: string, mtimeMs: number, size: number): Effect.Effect<void, CacheWriteError>;
    /** The same row {@link commit} would write, for a stage that batches its
     *  marks into one `putMany` with the rest of its writes. */
    row(path: string, mtimeMs: number, size: number): Record<string, DuckDbParam>;
}

export interface FileWatermarkConfig {
    /** The `source_kind` these marks are stored under, e.g. "claude_transcript". */
    readonly sourceKind: string;
    /** Env var whose value "1" forces a full re-derive, e.g. "AX_REDERIVE_CLAUDE". */
    readonly forceEnv: string;
}

const MarkRow = Schema.Struct({
    path: Schema.String,
    mtime_ms: Schema.NullOr(Schema.Number),
    size: Schema.NullOr(Schema.Number),
});

/**
 * Load this source kind's marks in ONE indexed read and hand back the value
 * object a stage's own loop uses.
 *
 * `write` is a PARAMETER rather than a service resolved from the environment,
 * because that is how the seam works: `withCacheWrite` hands a
 * `CacheWriteService` to a body and there is no `CacheWrite` service tag to
 * `yield*` - the ingest lock is the write capability, and a capability that
 * could be picked up from the environment would not be one.
 *
 * `forceEnv=1` yields an EMPTY map, so every input re-derives. It does not
 * delete the stored marks: a forced run that dies halfway would otherwise lose
 * the marks it never got to rewrite, turning one interrupted re-derive into a
 * second full one.
 */
export const fileWatermark = (
    write: CacheWriteService,
    cfg: FileWatermarkConfig,
): Effect.Effect<FileWatermark, CacheReadError> =>
    Effect.gen(function* () {
        const marks = new Map<string, { readonly mtimeMs: number; readonly size: number }>();

        if (process.env[cfg.forceEnv] !== "1") {
            const rows = yield* write.rows(
                MarkRow,
                `SELECT path, mtime_ms, size FROM ${WATERMARK_TABLE} WHERE source_kind = ?`,
                [cfg.sourceKind],
            );
            for (const row of rows) {
                if (row.mtime_ms === null || row.size === null) continue;
                marks.set(row.path, { mtimeMs: row.mtime_ms, size: row.size });
            }
        }

        const row = (path: string, mtimeMs: number, size: number) =>
            watermarkRow(cfg.sourceKind, path, { mtimeMs, size });

        return {
            unchanged: (path, mtimeMs, size) => {
                const mark = marks.get(path);
                return mark !== undefined && mark.mtimeMs === mtimeMs && mark.size === size;
            },
            commit: (path, mtimeMs, size) => write.put(WATERMARK_TABLE, row(path, mtimeMs, size)),
            row,
        } satisfies FileWatermark;
    });
