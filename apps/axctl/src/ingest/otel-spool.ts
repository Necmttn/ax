import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { defaultOtlpSpoolDir } from "../otel/spool-server.ts";
import { SIGNALS } from "../otel/signals.ts";
import { OTLP_SIGNAL_PATHS } from "../otel/signal.ts";
import { OtelWriter, OtelWriterLive } from "../otel/writer.ts";
import { runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import { walkJsonlFilesStrict, type JsonlFileCandidate } from "./walk-jsonl.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

interface SpoolEnvelope {
    readonly path: string;
    readonly body: string;
}

const decodeEnvelope = (line: string): SpoolEnvelope | null => {
    try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return typeof record.path === "string" && typeof record.body === "string"
            ? { path: record.path, body: record.body }
            : null;
    } catch {
        return null;
    }
};

const parseBody = (body: string): unknown | undefined => {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
};

export interface IngestOtelSpoolOptions {
    readonly spoolDir?: string;
    readonly runId?: string;
}

export interface OtelSpoolIngestResult {
    readonly files: number;
    readonly skippedUnchanged: number;
    readonly payloads: number;
    readonly rows: number;
    readonly malformed: number;
    readonly failedFiles: number;
}

/** Tail changed daily spool files and write decoded payloads with OtelWriter. */
export const ingestOtelSpool = (
    opts: IngestOtelSpoolOptions = {},
): Effect.Effect<
    OtelSpoolIngestResult,
    DbError | PlatformError.PlatformError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spoolDir = opts.spoolDir ?? defaultOtlpSpoolDir();
        const candidates = yield* walkJsonlFilesStrict(spoolDir, 0);
        let payloads = 0;
        let rows = 0;
        let malformed = 0;

        const result = yield* runJsonlProviderFiles<
            DbError | PlatformError.PlatformError,
            OtelWriter,
            JsonlFileCandidate
        >({
            candidates,
            sourceKind: "otel_spool",
            forceEnv: "AX_REDERIVE_OTEL_SPOOL",
            source: "otel-spool",
            ...(opts.runId === undefined ? {} : { runId: opts.runId }),
            processFile: (candidate) =>
                Effect.gen(function* () {
                    const text = yield* fs.readFileString(candidate.path);
                    const writer = yield* OtelWriter;
                    for (const line of text.split("\n")) {
                        if (line.trim().length === 0) continue;
                        const envelope = decodeEnvelope(line);
                        const signal = envelope ? OTLP_SIGNAL_PATHS[envelope.path] : undefined;
                        if (!envelope || !signal) {
                            malformed += 1;
                            continue;
                        }
                        const json = parseBody(envelope.body);
                        if (json === undefined) {
                            malformed += 1;
                            continue;
                        }
                        const spec = SIGNALS[signal];
                        const decoded = yield* spec.decode(json).pipe(
                            Effect.option,
                        );
                        if (decoded._tag === "None") {
                            malformed += 1;
                            continue;
                        }
                        const normalized = spec.normalize(decoded.value);
                        yield* spec.write(writer)(normalized);
                        payloads += 1;
                        rows += normalized.length;
                    }
                    return true;
                }),
        }).pipe(Effect.provide(OtelWriterLive));

        return {
            files: result.files,
            skippedUnchanged: result.skippedUnchanged,
            payloads,
            rows,
            malformed,
            failedFiles: result.failures.count(),
        };
    });

export const OtelSpoolKey = Schema.Literal("otel-spool");
export type OtelSpoolKey = typeof OtelSpoolKey.Type;

export class OtelSpoolStageStats extends BaseStageStats.extend<OtelSpoolStageStats>(
    "OtelSpoolStageStats",
)({
    filesIngested: Schema.Number,
    payloadsIngested: Schema.Number,
    rowsIngested: Schema.Number,
    malformedPayloads: Schema.Number,
    failedFiles: Schema.Number,
}) {}

export const otelSpoolStage: StageDef<
    OtelSpoolStageStats,
    SurrealClient | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "otel-spool", deps: [], tags: ["ingest"] }),
    run: Effect.fn(function* (ctx: IngestContext) {
        const t0 = Date.now();
        const result = yield* ingestOtelSpool({
            ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        }).pipe(Effect.catchTag("PlatformError", (error) => Effect.die(error)));
        return OtelSpoolStageStats.make({
            durationMs: Date.now() - t0,
            summary: `ingested ${result.payloads} OTLP payloads, ${result.rows} rows` +
                (result.malformed > 0 ? `, ${result.malformed} malformed payloads skipped` : "") +
                (result.failedFiles > 0 ? `, ${result.failedFiles} files failed` : ""),
            filesIngested: result.files,
            payloadsIngested: result.payloads,
            rowsIngested: result.rows,
            malformedPayloads: result.malformed,
            failedFiles: result.failedFiles,
        });
    }),
};
