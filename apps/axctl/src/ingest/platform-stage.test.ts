import { describe, expect, it } from "bun:test";
import { Effect, Layer, Path, PlatformError } from "effect";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { IngestContext } from "./stage/types.ts";
import { otelSpoolStage } from "./otel-spool.ts";
import { BaseStageStats } from "./stage/types.ts";
import { skipPlatformStage } from "./platform-stage.ts";

describe("platform stage failure boundary", () => {
    it("logs a warning and returns explicit zero-count stats", async () => {
        const error = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readDirectory",
            pathOrDescriptor: "/unreadable",
        });
        const stats = BaseStageStats.make({ durationMs: 0, summary: "skipped" });

        await expect(
            Effect.runPromise(skipPlatformStage("codex", error, () => stats)),
        ).resolves.toEqual(stats);
    });

    it("lets the OTLP stage complete after spool discovery fails", async () => {
        const error = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readDirectory",
            pathOrDescriptor: "/spool/2026-08-25.jsonl",
        });
        const previous = process.env.AX_OTLP_SPOOL_DIR;
        process.env.AX_OTLP_SPOOL_DIR = "/spool";
        try {
            const stats = await Effect.runPromise(
                otelSpoolStage.run(
                    IngestContext.make({ cwd: "/", since: new Date(0), debug: false }),
                    {} as CacheWriteService,
                ).pipe(
                    Effect.provide(Layer.mergeAll(
                        layerTestFileSystem(
                            { "/spool/2026-08-25.jsonl": "{}\n" },
                            { errors: { "/spool/2026-08-25.jsonl": error } },
                        ),
                        Path.layer,
                    )),
                ),
            );
            expect(stats).toMatchObject({
                summary: "otel-spool skipped (filesystem error; non-fatal)",
                filesIngested: 0,
                payloadsIngested: 0,
                rowsIngested: 0,
                malformedPayloads: 0,
                failedFiles: 1,
            });
        } finally {
            if (previous === undefined) delete process.env.AX_OTLP_SPOOL_DIR;
            else process.env.AX_OTLP_SPOOL_DIR = previous;
        }
    });
});
