import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchToolFailureDetail, fetchToolFailures, recommendForFailure } from "./tool-failures.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("tool-failures", { requireFts: true });

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [{ id: "s1", project: "ax" }]);
        const baseCall = {
            session: "s1",
            command_norm: null as string | null,
            command_text: null as string | null,
            has_error: false,
            exit_code: null as number | null,
            error_text: null as string | null,
            output_excerpt: null as string | null,
            cwd: null as string | null,
        };
        yield* w.putMany("tool_call", [
            // 3 failing "git push" calls (command_norm set) across 2 sessions.
            {
                ...baseCall,
                id: "tc1",
                name: "Bash",
                command_norm: "git push",
                command_text: "git push origin main",
                ts: new Date("2026-01-01T00:00:00Z"),
                has_error: true,
                exit_code: 1,
                error_text: "rejected",
                output_excerpt: "! [rejected]",
                cwd: "/repo",
            },
            {
                ...baseCall,
                id: "tc2",
                name: "Bash",
                command_norm: "git push",
                command_text: "git push origin main",
                ts: new Date("2026-01-02T00:00:00Z"),
                has_error: true,
                exit_code: 1,
                cwd: "/repo",
            },
            {
                ...baseCall,
                id: "tc3",
                name: "Bash",
                command_norm: "git push",
                command_text: "git push origin main",
                ts: new Date("2026-01-03T00:00:00Z"),
                has_error: true,
                exit_code: 128,
                cwd: "/repo",
            },
            // one non-failing call for the same label - excluded by has_error filter.
            {
                ...baseCall,
                id: "tc4",
                name: "Bash",
                command_norm: "git push",
                ts: new Date("2026-01-04T00:00:00Z"),
                has_error: false,
            },
            // a failure with no command_norm, falls back to `name`.
            {
                ...baseCall,
                id: "tc5",
                name: "WebFetch",
                ts: new Date("2026-01-01T00:00:00Z"),
                has_error: true,
            },
        ]);
    });

describe("fetchToolFailures", () => {
    dtest("groups by command_norm/name, counts distinct sessions and dedup'd exit codes", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-tool-failures-"), dylibPath, FIXTURE));
        const result = await readThroughFixture(fixture, dylibPath, fetchToolFailures());

        const gitPush = result.failures.find((f) => f.label === "git push");
        expect(gitPush).toBeDefined();
        expect(gitPush?.failure_count).toBe(3);
        expect(gitPush?.distinct_sessions).toBe(1);
        expect(gitPush?.exit_codes.slice().sort()).toEqual([1, 128]);
        expect(gitPush?.last_seen).toBe("2026-01-03T00:00:00.000Z");

        const webFetch = result.failures.find((f) => f.label === "WebFetch");
        expect(webFetch).toBeDefined();
        expect(webFetch?.failure_count).toBe(1);
    });
});

describe("fetchToolFailureDetail", () => {
    dtest("returns the last N failing rows for a label, newest first, with session project", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-tool-failures-detail-"), dylibPath, FIXTURE));
        const result = await readThroughFixture(fixture, dylibPath, fetchToolFailureDetail("git push"));

        expect(result.label).toBe("git push");
        expect(result.samples.length).toBe(3);
        expect(result.samples[0]?.ts).toBe("2026-01-03T00:00:00.000Z");
        expect(result.samples[0]?.exit_code).toBe(128);
        expect(result.samples[0]?.project).toBe("ax");
        expect(result.samples[0]?.session_id).toBe("s1");
        expect(result.samples[2]?.error_text).toBe("rejected");
    });
});

describe("recommendForFailure", () => {
    test("high failure count + recent + multi-session -> fix", () => {
        const rec = recommendForFailure({
            label: "git push",
            failure_count: 6,
            last_seen: new Date().toISOString(),
            last_error_text: null,
            last_project: null,
            distinct_sessions: 3,
            total_calls: 0,
            failure_rate: 0,
            exit_codes: [1],
        });
        expect(rec.recommendation).toBe("fix");
    });

    test("stale failure -> ignore", () => {
        const rec = recommendForFailure({
            label: "old-cmd",
            failure_count: 10,
            last_seen: new Date(Date.now() - 30 * 86400_000).toISOString(),
            last_error_text: null,
            last_project: null,
            distinct_sessions: 5,
            total_calls: 0,
            failure_rate: 0,
            exit_codes: [1],
        });
        expect(rec.recommendation).toBe("ignore");
    });
});
