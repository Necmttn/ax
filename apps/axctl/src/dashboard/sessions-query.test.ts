/**
 * Tests for src/dashboard/sessions-query.ts, against a REAL published DuckDB
 * cache fixture. The window semantics (repository scope, date bounds, project
 * filter) and the turn-count/first-user-message enrichment are all asserted
 * by seeding real `session`/`turn` rows and reading them back, not by
 * inspecting SQL text.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { listSessionsAround, listSessionsHere, listSessionsNear } from "./sessions-query.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("sessions-query", { requireFts: true });

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

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1" }));

        // s3 is repository r1 but 20 days old - outside the default 14d window.
        expect(rows.map((r) => r.id)).toEqual(["s1"]);
        expect(rows[0]).toMatchObject({ turn_count: 3, first_user_message: "first message" });
    });

    dtest("the summary skips an injected context turn for the first real task turn (#1029)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-context-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.put("session", { id: "sc", repository: "r1", source: "codex", project: "p", cwd: "/w/ax", started_at: daysAgo(1) });
                yield* w.putMany("turn", [
                    // Codex records the AGENTS.md system prompt as the first user
                    // turn, classified message_kind='context'.
                    { id: "c1", session: "sc", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "# AGENTS.md instructions for /w/ax", message_kind: "context" },
                    { id: "c2", session: "sc", seq: 2, ts: daysAgo(1), role: "user", text_excerpt: "fix the ingest bug", message_kind: "task" },
                ]);
            })));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1" }));
        expect(rows[0]?.first_user_message).toBe("fix the ingest bug");
    });

    dtest("a stale message_kind='task' harness preamble never outranks the real ask (#1095)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-preamble-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.put("session", { id: "sp", repository: "r1", source: "claude", project: "p", cwd: "/w/ax", started_at: daysAgo(1) });
                // Every row below is stamped message_kind='task' - a STALE
                // classification from before the classifier learned these
                // harness-wrapper shapes (#1095: message_kind is stamped at
                // ingest and a re-parse is never assumed to have happened).
                yield* w.putMany("turn", [
                    { id: "p1", session: "sp", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "<recommended_plugins> Here is a list of plugins available for this session", message_kind: "task", intent_kind: "organic_task" },
                    { id: "p2", session: "sp", seq: 2, ts: daysAgo(1), role: "user", text_excerpt: "<command-message>fleet-ship</command-message>", message_kind: "task", intent_kind: "organic_task" },
                    { id: "p3", session: "sp", seq: 3, ts: daysAgo(1), role: "user", text_excerpt: "<local-command-stdout>Login interrupted</local-command-stdout>", message_kind: "task", intent_kind: "organic_task" },
                    { id: "p4", session: "sp", seq: 4, ts: daysAgo(1), role: "user", text_excerpt: "some environment info: <environment_context>cwd=/w/ax</environment_context>", message_kind: "task", intent_kind: "organic_task" },
                    { id: "p5", session: "sp", seq: 5, ts: daysAgo(1), role: "user", text_excerpt: "fix the ingest bug for real this time", message_kind: "task", intent_kind: "organic_task" },
                ]);
            })));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1" }));
        expect(rows[0]?.first_user_message).toBe("fix the ingest bug for real this time");
    });

    dtest("returns no summary when every candidate is a stale preamble (#1095)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-preamble-only-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.put("session", { id: "sq", repository: "r1", source: "codex", project: "p", cwd: "/w/ax", started_at: daysAgo(1) });
                yield* w.putMany("turn", [
                    { id: "q1", session: "sq", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "<recommended_plugins> plugin list", message_kind: "task", intent_kind: "organic_task" },
                    { id: "q2", session: "sq", seq: 2, ts: daysAgo(1), role: "user", text_excerpt: "<local-command-stdout>done</local-command-stdout>", message_kind: "task", intent_kind: "organic_task" },
                ]);
            })));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1" }));
        expect(rows[0]?.first_user_message).toBeNull();
    });

    dtest("keeps similar human text and an attachment with typed text (#1095)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-human-marker-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.putMany("session", [
                    { id: "sh", repository: "r1", source: "claude", project: "p", cwd: "/w/ax", started_at: daysAgo(1) },
                    { id: "si", repository: "r1", source: "claude", project: "p", cwd: "/w/ax", started_at: daysAgo(1) },
                ]);
                yield* w.putMany("turn", [
                    { id: "h1", session: "sh", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "How should I display <recommended_plugins> output?", message_kind: "task", intent_kind: "organic_task" },
                    { id: "h2", session: "si", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "[Image: source: /tmp/a.png] Please fix this layout", message_kind: "task", intent_kind: "organic_task" },
                ]);
            })));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1" }));
        expect(rows.find((row) => row.id === "sh")?.first_user_message).toBe("How should I display <recommended_plugins> output?");
        expect(rows.find((row) => row.id === "si")?.first_user_message).toBe("[Image: source: /tmp/a.png] Please fix this layout");
    });

    dtest("respects a custom --days window", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-here-days-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsHere({ repositoryId: "r1", days: 30 }));

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

    dtest("a stale message_kind='task' harness preamble never outranks the real ask (#1095)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-around-preamble-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.put("session", { id: "sr", source: "claude", project: "p", started_at: daysAgo(1) });
                yield* w.putMany("turn", [
                    { id: "r1", session: "sr", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "<recommended_plugins> plugin list", message_kind: "task", intent_kind: "organic_task" },
                    { id: "r2", session: "sr", seq: 2, ts: daysAgo(1), role: "user", text_excerpt: "fix the ingest bug", message_kind: "task", intent_kind: "organic_task" },
                ]);
            })));

        const rows = await readThroughFixture(fixture, dylibPath, listSessionsAround({ date: daysAgo(1), days: 3 }));
        expect(rows.find((r) => r.id === "sr")?.first_user_message).toBe("fix the ingest bug");
    });
});

describe("listSessionsNear", () => {
    dtest("windows [from, to], scoped by repository when given", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-near-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsNear({ from: daysAgo(2), to: daysAgo(0), repositoryId: "r1" }),
        );

        expect(rows.map((r) => r.id)).toEqual(["s1"]);
    });

    dtest("omits the repository filter when repositoryKey is null", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-near-any-repo-"), dylibPath, FIXTURE));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsNear({ from: daysAgo(2), to: daysAgo(0), repositoryId: null }),
        );

        expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    });

    dtest("a stale message_kind='task' harness preamble never outranks the real ask (#1095)", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-sessions-near-preamble-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.put("session", { id: "sn", repository: "r1", source: "claude", project: "p", started_at: daysAgo(1) });
                yield* w.putMany("turn", [
                    { id: "n1", session: "sn", seq: 1, ts: daysAgo(1), role: "user", text_excerpt: "<recommended_plugins> plugin list", message_kind: "task", intent_kind: "organic_task" },
                    { id: "n2", session: "sn", seq: 2, ts: daysAgo(1), role: "user", text_excerpt: "fix the ingest bug", message_kind: "task", intent_kind: "organic_task" },
                ]);
            })));

        const rows = await readThroughFixture(
            fixture,
            dylibPath,
            listSessionsNear({ from: daysAgo(2), to: daysAgo(0), repositoryId: "r1" }),
        );
        expect(rows.find((r) => r.id === "sn")?.first_user_message).toBe("fix the ingest bug");
    });
});
