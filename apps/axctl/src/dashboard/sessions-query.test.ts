/**
 * Tests for src/dashboard/sessions-query.ts, against a REAL published DuckDB
 * cache fixture. The window semantics (repository scope, date bounds, project
 * filter) and the turn-count/first-user-message enrichment are all asserted
 * by seeding real `session`/`turn` rows and reading them back, not by
 * inspecting SQL text - the join/window approach the DuckDB port uses has no
 * SurrealQL analogue to compare strings against.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { listSessionsAround, listSessionsHere, listSessionsNear } from "./sessions-query.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("sessions-query");

const NOW = new Date();
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            {
                id: "s1",
                repository: "r1",
                source: "claude",
                project: "p",
                cwd: "/w/ax",
                started_at: daysAgo(1),
            },
            {
                id: "s2",
                repository: "r2",
                source: "claude",
                project: "other",
                cwd: "/w/other",
                started_at: daysAgo(1),
            },
            {
                id: "s3",
                repository: "r1",
                source: "codex",
                project: "p",
                cwd: "/w/ax",
                started_at: daysAgo(20),
            },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "s1", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "first message" },
            { id: "t2", session: "s1", seq: 2, ts: daysAgo(1), role: "assistant", text_excerpt: "reply" },
            { id: "t3", session: "s1", seq: 3, ts: daysAgo(1), role: "user", text_excerpt: "second user turn" },
            { id: "t4", session: "s2", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "other session" },
        ]);
    });

describe("listSessionsHere", () => {
    dtest("scopes by repository and the default 14-day window, enriching turn_count + first_user_message", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryKey: "r1" }));

        // s3 is repository r1 but 20 days old - outside the default 14d window.
        expect(rows.map((r) => r.id)).toEqual(["s1"]);
        expect(rows[0]).toMatchObject({ turn_count: 3, first_user_message: "first message" });
    });

    dtest("respects a custom --days window", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-days-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryKey: "r1", days: 30 }));

        expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s3"]);
    });
});

describe("listSessionsAround", () => {
    dtest("windows ±days around the centre date, no repository scope", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-around-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsAround({ date: daysAgo(1), days: 3 }));

        expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    });

    dtest("applies the project filter when given", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-around-project-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsAround({ date: daysAgo(1), days: 3, project: "other" }),
        );

        expect(rows.map((r) => r.id)).toEqual(["s2"]);
    });
});

describe("listSessionsNear", () => {
    dtest("windows [from, to], scoped by repository when given", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-near-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsNear({ from: daysAgo(2), to: daysAgo(0), repositoryKey: "r1" }),
        );

        expect(rows.map((r) => r.id)).toEqual(["s1"]);
    });

    dtest("omits the repository filter when repositoryKey is null", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-near-any-repo-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsNear({ from: daysAgo(2), to: daysAgo(0), repositoryKey: null }),
        );

        expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    });
});
