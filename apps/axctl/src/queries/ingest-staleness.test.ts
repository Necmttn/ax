import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CacheRead, CacheUnavailableError, type CacheReadService } from "@ax/lib/duckdb/seam";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import {
    fetchLastSuccessfulIngestAt,
    staleIngestThresholdMs,
    warnIfIngestStale,
    withIngestStalenessPreflight,
} from "./ingest-staleness.ts";

describe("staleIngestThresholdMs", () => {
    test("uses the default and accepts an explicit disable", () => {
        expect(staleIngestThresholdMs({} as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "6" } as NodeJS.ProcessEnv)).toBe(6 * 3_600_000);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    });

    // #697 finding 1: an exported-but-blank env var (launchd plist entry, a
    // bare `export AX_STALE_INGEST_HOURS=` shell profile line) must read as
    // UNSET, not as an explicit "0" disable - `Number("")` and `Number(" ")`
    // are both `0`, which is finite and `>= 0`. Without the guard this
    // silently turns the #697 stale-graph warning off.
    test("empty or whitespace-only value falls back to the 48h default (unset, not disabled)", () => {
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "" } as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "   " } as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
    });
});

describe("fetchLastSuccessfulIngestAt", () => {
    test("uses ended_at and falls back to started_at", async () => {
        const ended = new Date("2026-07-03T12:00:00.000Z");
        const started = new Date("2026-07-03T11:50:00.000Z");
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[{ ended_at: ended, started_at: started }]]))).toBe(ended.getTime());
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[{ ended_at: null, started_at: started }]]))).toBe(started.getTime());
    });

    test("returns null without a successful run", async () => {
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[]]))).toBeNull();
    });
});

describe("warnIfIngestStale (real seam)", () => {
    // Capture BOTH streams around the run: stdout must stay clean (`--json |
    // jq` breaks on a stray line there) and the warning IS the printed stderr
    // line. Patching stderr alone would catch a MOVE to stdout (the stale
    // case's captured stderr would just go empty) but not an ADDITION - e.g. a
    // stray `console.log(warning)` beside the stderr write. Also patch
    // `console.log` itself, not just `process.stdout.write`: verified live
    // that under Bun, `console.log` does NOT route through
    // `process.stdout.write` (it holds its own handle to the stream), so a
    // patch of `process.stdout.write` alone silently fails to observe it and
    // this test would pass even with the stray console.log left in.
    const captureOutput = async (
        effect: Effect.Effect<void, never, never>,
    ): Promise<{ stdout: string; stderr: string }> => {
        const originalStderr = process.stderr.write.bind(process.stderr);
        const originalStdout = process.stdout.write.bind(process.stdout);
        const originalConsoleLog = console.log;
        let stderr = "";
        let stdout = "";
        process.stderr.write = (chunk: string) => {
            stderr += String(chunk);
            return true;
        };
        process.stdout.write = (chunk: string) => {
            stdout += String(chunk);
            return true;
        };
        console.log = (...args: unknown[]) => {
            stdout += `${args.map(String).join(" ")}\n`;
        };
        try {
            await Effect.runPromise(effect);
        } finally {
            process.stderr.write = originalStderr;
            process.stdout.write = originalStdout;
            console.log = originalConsoleLog;
        }
        return { stdout, stderr };
    };

    /** The one `ingest_run` row the reader selects, as a published cache would return it. */
    const okRunFrom = (at: Date): Layer.Layer<CacheRead> =>
        cacheReadResults([[{ ended_at: at, started_at: at }]]);

    /**
     * A cache that cannot be opened - the v2 equivalent of the old
     * "DB unreachable" case. `cacheReadResults` can only succeed, so the
     * fail-open path needs its own stub; without one, "never fails" is asserted
     * nowhere and a future `Effect.ignoreCause` removal goes unnoticed.
     */
    const unopenableCache: Layer.Layer<CacheRead> = Layer.succeed(CacheRead, {
        snapshotPath: "(test)",
        rows: () =>
            Effect.fail(
                new CacheUnavailableError({ path: "(test)", message: "no snapshot published" }),
            ),
        first: () =>
            Effect.fail(
                new CacheUnavailableError({ path: "(test)", message: "no snapshot published" }),
            ),
        raw: () =>
            Effect.fail(
                new CacheUnavailableError({ path: "(test)", message: "no snapshot published" }),
            ),
    } as unknown as CacheReadService);

    test("prints one warning line to stderr, and nothing to stdout, when the last ok ingest is older than 48h", async () => {
        const db = okRunFrom(new Date(Date.now() - 13 * 86_400_000));
        const { stdout, stderr } = await captureOutput(warnIfIngestStale.pipe(Effect.provide(db)));

        expect(stderr).toContain("graph is stale");
        expect(stderr).toContain("13d ago");
        expect(stderr.trimEnd().split("\n")).toHaveLength(1);
        // Load-bearing: `ax cost --json | jq` must never see this line.
        expect(stdout).toBe("");
    });

    test("stays silent when the graph is fresh", async () => {
        const db = okRunFrom(new Date(Date.now() - 3_600_000));
        const { stdout, stderr } = await captureOutput(warnIfIngestStale.pipe(Effect.provide(db)));
        expect(stderr).toBe("");
        expect(stdout).toBe("");
    });

    test("degrades silently when the cache cannot be opened", async () => {
        const { stdout, stderr } = await captureOutput(
            warnIfIngestStale.pipe(Effect.provide(unopenableCache)),
        );
        expect(stderr).toBe("");
        expect(stdout).toBe("");
    });

    test("runs as a preflight before the command body", async () => {
        // Seeded STALE on purpose. With a FRESH run no warning fires at all, so
        // the resulting `["command"]` would be equally consistent with the
        // preflight running last, or never - proving nothing about ordering.
        const db = okRunFrom(new Date(Date.now() - 13 * 86_400_000));
        const originalStderr = process.stderr.write.bind(process.stderr);
        const events: string[] = [];
        process.stderr.write = () => {
            events.push("warning");
            return true;
        };
        try {
            await Effect.runPromise(
                withIngestStalenessPreflight(
                    Effect.sync(() => {
                        events.push("command");
                    }),
                ).pipe(Effect.provide(db)),
            );
        } finally {
            process.stderr.write = originalStderr;
        }

        expect(events).toEqual(["warning", "command"]);
    });
});
