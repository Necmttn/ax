import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DbError } from "@ax/lib/errors";
import { makeMockDb, makeTestSurrealClient, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchLastSuccessfulIngestAt,
    staleIngestThresholdMs,
    warnIfIngestStale,
    withIngestStalenessPreflight,
} from "./ingest-staleness.ts";

describe("staleIngestThresholdMs", () => {
    test("defaults to 48h", () => {
        expect(staleIngestThresholdMs({} as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
    });

    test("honours AX_STALE_INGEST_HOURS; 0 disables", () => {
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
    test("reads the newest ok run via one status-filtered indexed query", async () => {
        const db = makeMockDb([[[{ ended_at: "2026-07-03T12:00:00.000Z", started_at: "2026-07-03T11:50:00.000Z" }]]]);
        const at = await runWithMock(db, fetchLastSuccessfulIngestAt);

        expect(at).toBe(Date.parse("2026-07-03T12:00:00.000Z"));
        expect(db.captured).toHaveLength(1);
        // Must hit the ingest_run_status_started index: filter on status, order
        // by started_at. A full scan here would tax every read command.
        expect(db.captured[0]).toContain("FROM ingest_run");
        expect(db.captured[0]).toContain("status = 'ok'");
        expect(db.captured[0]).toContain("ORDER BY started_at DESC");
        expect(db.captured[0]).toContain("LIMIT 1");
    });

    test("falls back to started_at when ended_at is absent", async () => {
        const db = makeMockDb([[[{ started_at: "2026-07-03T11:50:00.000Z" }]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBe(Date.parse("2026-07-03T11:50:00.000Z"));
    });

    test("null when no ok run exists", async () => {
        const db = makeMockDb([[[]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBeNull();
    });

    test("null when the timestamps are unparseable", async () => {
        const db = makeMockDb([[[{ ended_at: "not-a-date" }]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBeNull();
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

    const okRunFrom = (iso: string) =>
        makeTestSurrealClient({ routes: { "FROM ingest_run": [[{ ended_at: iso, started_at: iso }]] } });

    test("prints one warning line to stderr, and nothing to stdout, when the last ok ingest is older than 48h", async () => {
        const db = okRunFrom(new Date(Date.now() - 13 * 86_400_000).toISOString());
        const { stdout, stderr } = await captureOutput(warnIfIngestStale.pipe(Effect.provide(db.layer)));

        expect(stderr).toContain("graph is stale");
        expect(stderr).toContain("13d ago");
        expect(stderr.trimEnd().split("\n")).toHaveLength(1);
        // Load-bearing: `ax cost --json | jq` must never see this line.
        expect(stdout).toBe("");
    });

    test("stays silent when the graph is fresh", async () => {
        const db = okRunFrom(new Date(Date.now() - 3_600_000).toISOString());
        const { stdout, stderr } = await captureOutput(warnIfIngestStale.pipe(Effect.provide(db.layer)));
        expect(stderr).toBe("");
        expect(stdout).toBe("");
    });

    test("degrades silently when the DB is unreachable", async () => {
        const db = makeTestSurrealClient({
            routes: {
                "FROM ingest_run": Effect.fail(
                    new DbError({ operation: "query", message: "connection refused" }),
                ),
            },
        });
        const { stdout, stderr } = await captureOutput(warnIfIngestStale.pipe(Effect.provide(db.layer)));
        expect(stderr).toBe("");
        expect(stdout).toBe("");
    });

    test("runs as a preflight before the command body", async () => {
        const db = okRunFrom(new Date(Date.now() - 13 * 86_400_000).toISOString());
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
                ).pipe(Effect.provide(db.layer)),
            );
        } finally {
            process.stderr.write = originalStderr;
        }

        expect(events).toEqual(["warning", "command"]);
    });
});
