import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { TraceSink } from "@ax/lib/live-traces/Sink";
import { ProcessServiceLive } from "@ax/lib/process";
import { Effect, Exit, Layer } from "effect";
import { FIRST_RUN_INGEST_TIMEOUT_SECONDS } from "../../ingest/deadline.ts";
import { runIngest, type RunIngestOptions } from "../../ingest/run.ts";
import { StageRegistryLive } from "../../ingest/stage/registry.ts";
import {
    cmdIngest,
    resolveIngestCommandTiming,
    type IngestCommandDeps,
} from "./ingest.ts";

const NOW_MS = Date.parse("2026-08-26T00:00:00Z");

const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
};

describe("ingest command deadline wiring", () => {
    test("one timing decision supplies both the derive deadline and lock timeout", () => {
        const firstRun = resolveIngestCommandTiming({
            configuredSeconds: 900,
            knobExplicitlySet: false,
            firstRun: true,
            nowMs: NOW_MS,
        });
        expect(firstRun.lockOptions.timeoutSeconds).toBe(FIRST_RUN_INGEST_TIMEOUT_SECONDS);
        expect(firstRun.runOptions.deadlineMs).toBe(
            NOW_MS + firstRun.decision.seconds * 1000,
        );

        const explicit = resolveIngestCommandTiming({
            configuredSeconds: 37,
            knobExplicitlySet: true,
            firstRun: true,
            nowMs: NOW_MS,
        });
        expect(explicit.lockOptions.timeoutSeconds).toBe(37);
        expect(explicit.runOptions.deadlineMs).toBe(NOW_MS + 37_000);
    });

    test("derive-only with AX_STAGE_HUNG_SECONDS=180 does not inherit a divided shared deadline", () => {
        const timing = resolveIngestCommandTiming({
            configuredSeconds: 900,
            knobExplicitlySet: false,
            firstRun: false,
            deriveOnly: true,
            nowMs: NOW_MS,
        });
        expect(timing.runOptions).toEqual({});
        expect(timing.lockOptions).toEqual({});
    });

    test("real lock seam leaves an unset derive-only timeout disabled", async () => {
        const dataDir = mkdtempSync(join(tmpdir(), "ax-ingest-lock-seam-"));
        const lockPath = join(dataDir, "ingest.lock");
        const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
        const run = (timeoutSeconds?: number) => withIngestLock(
            {
                lockPath,
                command: "test",
                staleMs: 10_000,
                ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
                onBusy: () => Effect.succeed("busy" as const),
            },
            Effect.sleep(20).pipe(Effect.as("completed" as const)),
        ).pipe(Effect.provide(platform));
        try {
            expect((await Effect.runPromise(run()))._tag).toBe("completed");
            expect((await Effect.runPromise(run(0.001)))._tag).toBe("timeout");
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    test("the real cmdIngest boundary forwards first-run and explicit deadlines", async () => {
        const previousSnapshot = process.env.AX_DUCKDB_SNAPSHOT;
        const previousTimeout = process.env.AX_INGEST_TIMEOUT_SECONDS;
        const dirs: string[] = [];

        const capture = async (
            configuredSeconds: number,
            explicitTimeout: string | undefined,
        ): Promise<{
            readonly runOptions: RunIngestOptions;
            readonly lockTimeoutSeconds: number | undefined;
        }> => {
            const dataDir = mkdtempSync(join(tmpdir(), "ax-ingest-deadline-wiring-"));
            dirs.push(dataDir);
            process.env.AX_DUCKDB_SNAPSHOT = join(dataDir, "missing-snapshot.duckdb");
            if (explicitTimeout === undefined) delete process.env.AX_INGEST_TIMEOUT_SECONDS;
            else process.env.AX_INGEST_TIMEOUT_SECONDS = explicitTimeout;

            const observed: RunIngestOptions[] = [];
            const fakeRunIngest: typeof runIngest = (options) => {
                observed.push(options);
                return Effect.die(new Error("stop after deadline capture"));
            };
            let lockTimeoutSeconds: number | undefined;
            const captureLock: typeof withIngestLock = (options, work) => {
                lockTimeoutSeconds = options.timeoutSeconds;
                return withIngestLock(options, work);
            };
            const deps: IngestCommandDeps = {
                nowMs: () => NOW_MS,
                runIngest: fakeRunIngest,
                withIngestLock: captureLock,
            };
            const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
            const layer = Layer.mergeAll(
                platform,
                ProcessServiceLive,
                StageRegistryLive([]),
                Layer.mock(TraceSink, { emit: () => undefined }),
                AxConfigTest({
                    paths: { dataDir },
                    knobs: { ingestTimeoutSeconds: configuredSeconds },
                }).pipe(Layer.provide(platform)),
            );

            const exit = await Effect.runPromiseExit(
                cmdIngest([], {}, deps).pipe(Effect.provide(layer)),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            expect(observed).toHaveLength(1);
            return { runOptions: observed[0]!, lockTimeoutSeconds };
        };

        try {
            const firstRun = await capture(900, undefined);
            expect(firstRun.runOptions.deadlineMs).toBe(
                NOW_MS + FIRST_RUN_INGEST_TIMEOUT_SECONDS * 1000,
            );
            expect(firstRun.lockTimeoutSeconds).toBe(FIRST_RUN_INGEST_TIMEOUT_SECONDS);

            const explicit = await capture(37, "37");
            expect(explicit.runOptions.deadlineMs).toBe(NOW_MS + 37_000);
            expect(explicit.lockTimeoutSeconds).toBe(37);
        } finally {
            restoreEnv("AX_DUCKDB_SNAPSHOT", previousSnapshot);
            restoreEnv("AX_INGEST_TIMEOUT_SECONDS", previousTimeout);
            for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        }
    });
});
