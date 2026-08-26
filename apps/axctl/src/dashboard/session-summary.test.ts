import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchSessionSummary } from "./session-summary.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session summary", { requireFts: true });

describe("session summary", () => {
    dtest("reads one session summary through CacheRead", async () => {
        const ts = new Date("2026-08-15T00:00:00Z");
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-session-summary-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s1", source: "claude", started_at: ts });
            yield* db.putMany("turn", [
                { id: "t1", session: "s1", seq: 1, ts, role: "user", message_kind: "task", text_excerpt: "Build it", has_tool_use: false, has_error: false },
                { id: "t2", session: "s1", seq: 2, ts, role: "assistant", message_kind: "assistant", text_excerpt: "Done", has_tool_use: false, has_error: false },
            ]);
            yield* db.put("session_health", { id: "h1", session: "s1", source: "claude", turns: 2, task_label: "Build it", ts });
            yield* db.put("session_token_usage", { id: "u1", session: "s1", source: "claude", model: "m1", estimated_tokens: 100, transcript_bytes: 1, estimated_cost_usd: 0.5, ts });
            yield* db.put("tool_call", { id: "tc1", session: "s1", name: "Read", ts, has_error: false });
        })));
        const summary = await readThroughFixture(fixture, dylibPath, fetchSessionSummary("session:s1"));
        expect(summary).toMatchObject({ session_id: "s1", task: "Build it", last_assistant: "Done", turns: 2, tokens: 100, cost_usd: 0.5, model: "m1", tools: [{ name: "Read", count: 1 }] });
    });

    dtest("a stale message_kind='task' harness preamble never wins first_ask/task over the real ask (#1095)", async () => {
        const ts = new Date("2026-08-15T00:00:00Z");
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-session-summary-preamble-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s2", source: "claude", started_at: ts });
            yield* db.putMany("turn", [
                // Every row below carries a STALE message_kind='task' - stamped
                // before the classifier learned these harness-wrapper shapes.
                { id: "t1", session: "s2", seq: 1, ts, role: "user", message_kind: "task", intent_kind: "organic_task", text_excerpt: "<recommended_plugins> Here is a list of plugins available for this session" },
                { id: "t2", session: "s2", seq: 2, ts, role: "user", message_kind: "task", intent_kind: "organic_task", text_excerpt: "<local-command-stdout>Login interrupted</local-command-stdout>" },
                { id: "t3", session: "s2", seq: 3, ts, role: "user", message_kind: "task", intent_kind: "organic_task", text_excerpt: "Build the ingest fix" },
            ]);
        })));
        const summary = await readThroughFixture(fixture, dylibPath, fetchSessionSummary("session:s2"));
        expect(summary.first_ask).toBe("Build the ingest fix");
        expect(summary.task).toBe("Build the ingest fix");
    });

    dtest("a session with no genuine task has no summary (#1095)", async () => {
        const ts = new Date("2026-08-15T00:00:00Z");
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-session-summary-no-task-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s3", source: "claude", started_at: ts });
            // Every user turn is a stale-classified harness wrapper - there is no
            // genuine ask, and no session_health.task_label either.
            yield* db.putMany("turn", [
                { id: "t1", session: "s3", seq: 1, ts, role: "user", message_kind: "task", intent_kind: "organic_task", text_excerpt: "<recommended_plugins> plugin list" },
                { id: "t2", session: "s3", seq: 2, ts, role: "user", message_kind: "task", intent_kind: "organic_task", text_excerpt: "<local-command-stdout>done</local-command-stdout>" },
            ]);
        })));
        const summary = await readThroughFixture(fixture, dylibPath, fetchSessionSummary("session:s3"));
        // No unrestricted "any user turn" fallback (#1095): reporting nothing is
        // correct here, not a plausible-looking wrapper preamble.
        expect(summary.first_ask).toBeNull();
        expect(summary.task).toBeNull();
    });
});
