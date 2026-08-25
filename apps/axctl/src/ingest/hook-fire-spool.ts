import { Effect, FileSystem, Option, Path, Schema, type PlatformError } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { telemetryCacheRow } from "@ax/lib/telemetry-base";
import {
    defaultHookFireSpoolDir,
    type HookFireSpoolError,
    HookFireSpoolJson,
    snapshotHookFireSpool,
} from "../hooks/spool.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { skipPlatformStage } from "./platform-stage.ts";

export interface DrainHookFireSpoolOptions {
    readonly spoolDir?: string;
}

export interface DrainHookFireSpoolResult {
    readonly files: number;
    readonly rows: number;
    readonly malformed: number;
}

const decodeEnvelope = Schema.decodeUnknownOption(HookFireSpoolJson);

/**
 * Replay the bounded hook journal into DuckDB. Stable row ids make replay safe.
 *
 * The drain does not truncate a file that request processes can append to.
 * Such truncation has a read-then-rename race that can remove a synced record.
 * The two-file rotation bounds disk use, and each ingest safely upserts the
 * retained window again.
 */
export const drainHookFireSpool = (
    write: CacheWriteService,
    options: DrainHookFireSpoolOptions = {},
): Effect.Effect<
    DrainHookFireSpoolResult,
    CacheWriteError | PlatformError.PlatformError | HookFireSpoolError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const spoolDir = options.spoolDir ?? defaultHookFireSpoolDir();
        let files = 0;
        let rows = 0;
        let malformed = 0;

        const snapshot = yield* snapshotHookFireSpool({ spoolDir });
        for (const { text } of snapshot) {
            files += 1;
            const lines = text.split("\n");
            if (!text.endsWith("\n")) {
                const torn = lines.pop();
                if (torn?.trim()) malformed += 1;
            }
            for (const line of lines) {
                if (!line.trim()) continue;
                const decoded = decodeEnvelope(line);
                if (Option.isNone(decoded)) {
                    malformed += 1;
                    continue;
                }
                const row = decoded.value.row;
                const ts = new Date(row.ts);
                if (!Number.isFinite(ts.getTime())) {
                    malformed += 1;
                    continue;
                }
                yield* write.put(
                    "hook_fire",
                    telemetryCacheRow({
                        ...row,
                        ts,
                        session: row.session ?? undefined,
                        file: row.file ?? undefined,
                    }),
                );
                rows += 1;
            }
        }
        return { files, rows, malformed };
    });

export const HookFireSpoolKey = Schema.Literal("hook-fire-spool");
export type HookFireSpoolKey = typeof HookFireSpoolKey.Type;

export class HookFireSpoolStageStats extends BaseStageStats.extend<HookFireSpoolStageStats>("HookFireSpoolStageStats")({
    filesRead: Schema.Number,
    rowsIngested: Schema.Number,
    malformedRows: Schema.Number,
}) {}

const EMPTY_DRAIN: DrainHookFireSpoolResult = { files: 0, rows: 0, malformed: 0 };

/**
 * Write-aware stage definition, registered in `ALL_STAGES`.
 *
 * The runner hands every stage the `CacheWriteService` (see `StageDef.run`), so
 * the drain runs on the ordinary ingest pass - the same shape `otelSpoolStage`
 * uses. Without the registration nothing ever reads the spool and `ax hook log`
 * reads an empty table forever, because this wave removed the direct write.
 *
 * Two error kinds, handled differently, because `runPipeline` aborts the WHOLE
 * run on either a stage failure or a defect:
 *   - `PlatformError` is a genuine filesystem fault -> log a warning and
 *     return zero stats at the stage boundary.
 *   - `HookFireSpoolError` is dominated by spool-lock contention (a hook firing
 *     while ingest runs). The spool is never truncated and the drain is
 *     idempotent, so the right response is to defer to the next pass, not to
 *     kill an ingest run. Fail OPEN with the reason in the stage summary.
 */
export const hookFireSpoolStage: StageDef<
    HookFireSpoolStageStats,
    FileSystem.FileSystem | Path.Path,
    CacheWriteError
> = {
    meta: StageMeta.make({ key: "hook-fire-spool", deps: [], tags: ["ingest"], writes: [{ table: "hook_fire", mode: "parse" }] }),
    run: Effect.fn(function* (_ctx: IngestContext, write: CacheWriteService) {
        const started = Date.now();
        const empty = (error: PlatformError.PlatformError) => HookFireSpoolStageStats.make({
            durationMs: Date.now() - started,
            summary: "hook-fire-spool skipped (filesystem error; non-fatal)",
            filesRead: 0,
            rowsIngested: 0,
            malformedRows: 0,
            failedOpenError: error.message,
        });
        return yield* drainHookFireSpool(write).pipe(
            Effect.map((result) => ({ result, deferred: null as string | null })),
            Effect.catchTag("HookFireSpoolError", (error) =>
                Effect.logWarning(
                    `ingest: hook fire spool not drained this pass - ${error.message}. ` +
                        `The spool is retained; the next ingest replays it.`,
                    ).pipe(Effect.as({ result: EMPTY_DRAIN, deferred: error.message as string | null })),
            ),
            Effect.map((outcome) => HookFireSpoolStageStats.make({
                durationMs: Date.now() - started,
                summary: outcome.deferred !== null
                    ? `deferred: ${outcome.deferred}`
                    : `ingested ${outcome.result.rows} hook fire rows` +
                        (outcome.result.malformed > 0
                            ? `, ${outcome.result.malformed} malformed rows skipped`
                            : ""),
                filesRead: outcome.result.files,
                rowsIngested: outcome.result.rows,
                malformedRows: outcome.result.malformed,
            })),
            Effect.catchTag("PlatformError", (error) => skipPlatformStage("hook-fire-spool", error, empty)),
        );
    }),
};
