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

/**
 * Write-aware stage definition.
 *
 * The current stage runner does not pass `CacheWriteService` yet. The live
 * writer stack can register this descriptor without changing the drain or
 * granting a writer to request paths.
 */
export const hookFireSpoolStage = {
    meta: StageMeta.make({ key: "hook-fire-spool", deps: [], tags: ["ingest"] }),
    run: Effect.fn(function* (_ctx: IngestContext, write: CacheWriteService) {
        const started = Date.now();
        const result = yield* drainHookFireSpool(write);
        return HookFireSpoolStageStats.make({
            durationMs: Date.now() - started,
            summary:
                `ingested ${result.rows} hook fire rows` +
                (result.malformed > 0 ? `, ${result.malformed} malformed rows skipped` : ""),
            filesRead: result.files,
            rowsIngested: result.rows,
            malformedRows: result.malformed,
        });
    }),
};
