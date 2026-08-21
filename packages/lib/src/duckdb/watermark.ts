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
 *
 * THE CONTENT-HASH TIER (#900, Phase 4 piece 3). File-form marks can opt into
 * a second, durable change check: `contentHash: true` stores a SHA-256 of the
 * file's bytes in the previously-NULL `sha` column. The fast tier is
 * unchanged - (mtime,size) match still skips with no read. When (mtime,size)
 * MOVED, the caller hashes the bytes and compares against `storedSha`: equal
 * means mtime churn / resync / touch, so the caller refreshes the mark and
 * skips the parse (the jsonl work-unit's third outcome). SHA-256 and NOT
 * `stableDigest`/`Bun.hash`, deliberately: a stored cross-run hash on a
 * version-unstable 64-bit hash would silently invalidate every mark on a bun
 * upgrade. The one-time eager backfill (operator decision on #893, measured
 * 5.9s over the 5.63 GB corpus) hashes each already-marked file whose CURRENT
 * (mtime,size) still equals its mark - only then does the hash describe the
 * bytes that were actually parsed; a file that moved since its mark keeps a
 * NULL sha and re-parses normally. A per-kind sentinel row versioned by
 * {@link CONTENT_HASH_VERSION} makes the backfill run once per kind.
 *
 * RULING R6: runtime module under `packages/lib/src/` - `node:fs`/`node:path`
 * are banned (`check:no-node-fs`); file access goes through `Bun.file`.
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

/** Version tag stored in the per-kind backfill sentinel's `sha`. Bump it to
 *  re-run the backfill (e.g. on an algorithm change). */
export const CONTENT_HASH_VERSION = "sha256-v1";

/** Sentinel path for the per-kind content-hash backfill marker. Embeds the
 *  kind because the DDL keeps ONE global `UNIQUE (path)` - two kinds writing
 *  the same sentinel path would be a constraint violation, not two rows. */
export const contentHashSentinelPath = (sourceKind: string): string =>
    `__content_hash_backfill__/${sourceKind}`;

/** SHA-256 of a file's bytes, hex. Fail-open: any read error yields null and
 *  the caller falls back to parsing (worst case = the pre-#900 behavior). */
export const hashFileSha256 = (path: string): Effect.Effect<string | null> =>
    Effect.promise(async () => {
        try {
            const bytes = await Bun.file(path).arrayBuffer();
            const hasher = new Bun.CryptoHasher("sha256");
            hasher.update(bytes);
            return hasher.digest("hex");
        } catch {
            return null;
        }
    });

/** Sentinel path for a mark imported via `ax segment import` (#902): the
 *  original path is another machine's, so the mark is keyed by content. The
 *  hash-indexed lookup ({@link FileWatermark.knownContentSha}) is what makes
 *  it useful - a file with those bytes landing at ANY local path skips its
 *  first parse. Embeds the kind for the same UNIQUE(path) reason as
 *  {@link contentHashSentinelPath}. */
export const importedMarkPath = (sourceKind: string, sha: string): string => `__imported__/${sourceKind}/${sha}`;

const isSentinelMarkPath = (path: string): boolean =>
    path.startsWith("__content_hash_backfill__/") || path.startsWith("__imported__/");

export interface FileWatermark {
    /** true => the on-disk (mtime,size) matches the stored mark => skip. */
    unchanged(path: string, mtimeMs: number, size: number): boolean;
    /** The stored content hash for the durable tier, or null when the mark
     *  has none (legacy row, hash failure, or `contentHash` off). */
    storedSha(path: string): string | null;
    /** true => a segment import sentinel (`importedMarkPath`) attests that
     *  bytes with this hash were already fully ingested. Ordinary file marks
     *  do not qualify: provider output may depend on the file path, so equal
     *  bytes at a new path still need parsing. Always false under forceEnv. */
    knownContentSha(sha: string): boolean;
    /** Write the mark. Call only AFTER the file's own writes succeed. */
    commit(path: string, mtimeMs: number, size: number, sha?: string | null): Effect.Effect<void, CacheWriteError>;
    /** The same row {@link commit} would write, for a stage that batches its
     *  marks into one `putMany` with the rest of its writes. */
    row(path: string, mtimeMs: number, size: number, sha?: string | null): Record<string, DuckDbParam>;
}

export interface FileWatermarkConfig {
    /** The `source_kind` these marks are stored under, e.g. "claude_transcript". */
    readonly sourceKind: string;
    /** Env var whose value "1" forces a full re-derive, e.g. "AX_REDERIVE_CLAUDE". */
    readonly forceEnv: string;
    /** Opt into the SHA-256 content tier (#900): loads stored shas for
     *  {@link FileWatermark.storedSha} and runs the one-time eager backfill
     *  for this kind. File-form callers that want resync resilience set it;
     *  append-only kinds (the otel spool) and non-file kinds leave it off. */
    readonly contentHash?: boolean;
}

const MarkRow = Schema.Struct({
    path: Schema.String,
    mtime_ms: Schema.NullOr(Schema.Number),
    size: Schema.NullOr(Schema.Number),
    sha: Schema.NullOr(Schema.String),
});

const SentinelRow = Schema.Struct({ sha: Schema.NullOr(Schema.String) });

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
): Effect.Effect<FileWatermark, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        const marks = new Map<string, { readonly mtimeMs: number; readonly size: number; sha: string | null }>();
        const forced = process.env[cfg.forceEnv] === "1";

        const loadRows = write.rows(
            MarkRow,
            `SELECT path, mtime_ms, size, sha FROM ${WATERMARK_TABLE} WHERE source_kind = ?`,
            [cfg.sourceKind],
        );
        let rows = forced && cfg.contentHash !== true ? [] : yield* loadRows;

        // The one-time eager content-hash backfill (#900). Only files whose
        // CURRENT (mtime,size) still equals the stored mark are hashed - for
        // those the bytes on disk ARE the bytes that were parsed. A file that
        // moved since its mark keeps sha NULL and re-parses normally, stamping
        // its sha then. Runs once per kind, re-armed by a version bump.
        if (cfg.contentHash === true) {
            const sentinelPath = contentHashSentinelPath(cfg.sourceKind);
            const sentinel = yield* write.rows(
                SentinelRow,
                `SELECT sha FROM ${WATERMARK_TABLE} WHERE path = ?`,
                [sentinelPath],
            );
            if (sentinel[0]?.sha !== CONTENT_HASH_VERSION) {
                const updated: Array<Record<string, DuckDbParam>> = [];
                const patched: MarkRowT[] = [];
                for (const mark of rows) {
                    if (mark.path.startsWith("__content_hash_backfill__/")) {
                        patched.push(mark);
                        continue;
                    }
                    if (mark.mtime_ms === null || mark.size === null) {
                        patched.push(mark);
                        continue;
                    }
                    const stat = yield* Effect.promise(async () => {
                        try {
                            return await Bun.file(mark.path).stat();
                        } catch {
                            return null;
                        }
                    });
                    // Whole-ms grain, deliberately: the walkers store
                    // `stats.mtime.getTime()` (integer ms) while
                    // `Bun.file().stat().mtimeMs` carries fractional ms, so a
                    // strict compare would skip nearly every mark.
                    if (
                        stat === null
                        || Math.floor(stat.mtimeMs) !== Math.floor(mark.mtime_ms)
                        || stat.size !== mark.size
                    ) {
                        patched.push(mark);
                        continue;
                    }
                    const sha = yield* hashFileSha256(mark.path);
                    if (sha === null) {
                        patched.push(mark);
                        continue;
                    }
                    updated.push(watermarkRow(cfg.sourceKind, mark.path, { mtimeMs: mark.mtime_ms, size: mark.size, sha }));
                    patched.push({ ...mark, sha });
                }
                if (updated.length > 0) yield* write.putMany(WATERMARK_TABLE, updated);
                yield* write.put(
                    WATERMARK_TABLE,
                    watermarkRow(cfg.sourceKind, sentinelPath, { sha: CONTENT_HASH_VERSION }),
                );
                rows = patched;
            }
        }

        // Cross-path reuse is reserved for `__imported__/` sentinel marks
        // (#902), whose sha explicitly attests that the bytes were loaded by
        // `segment import`. A real file mark only proves that exact path was
        // processed: provider output can derive identity from its path, so a
        // byte-identical file at a new path must still parse (#927). Empty
        // under force, so a forced run reparses everything.
        const importedShas = new Set<string>();
        if (!forced) {
            for (const row of rows) {
                if (row.sha !== null && row.path.startsWith("__imported__/")) importedShas.add(row.sha);
                if (isSentinelMarkPath(row.path)) continue;
                if (row.mtime_ms === null || row.size === null) continue;
                marks.set(row.path, { mtimeMs: row.mtime_ms, size: row.size, sha: row.sha });
            }
        }

        const row = (path: string, mtimeMs: number, size: number, sha?: string | null) =>
            watermarkRow(cfg.sourceKind, path, { mtimeMs, size, sha: sha ?? null });

        return {
            unchanged: (path, mtimeMs, size) => {
                const mark = marks.get(path);
                return mark !== undefined && mark.mtimeMs === mtimeMs && mark.size === size;
            },
            storedSha: (path) => marks.get(path)?.sha ?? null,
            knownContentSha: (sha) => importedShas.has(sha),
            commit: (path, mtimeMs, size, sha) => write.put(WATERMARK_TABLE, row(path, mtimeMs, size, sha)),
            row,
        } satisfies FileWatermark;
    });

type MarkRowT = typeof MarkRow.Type;
