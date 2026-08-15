import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchSessionSummary } from "./session-summary.ts";
import { publishDashboardFixture, runDashboardRead } from "./testing/duckdb.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session summary");

describe("session summary", () => {
    dtest("reads one session summary through CacheRead", async () => {
        const ts = new Date("2026-08-15T00:00:00Z");
        const fixture = await publishDashboardFixture(tempDir("ax-session-summary-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s1", source: "claude", started_at: ts });
            yield* db.putMany("turn", [
                { id: "t1", session: "s1", seq: 1, ts, role: "user", message_kind: "task", text_excerpt: "Build it", has_tool_use: false, has_error: false },
                { id: "t2", session: "s1", seq: 2, ts, role: "assistant", message_kind: "assistant", text_excerpt: "Done", has_tool_use: false, has_error: false },
            ]);
            yield* db.put("session_health", { id: "h1", session: "s1", source: "claude", turns: 2, task_label: "Build it", ts });
            yield* db.put("session_token_usage", { id: "u1", session: "s1", source: "claude", model: "m1", estimated_tokens: 100, transcript_bytes: 1, estimated_cost_usd: 0.5, ts });
            yield* db.put("tool_call", { id: "tc1", session: "s1", name: "Read", ts, has_error: false });
        }));
        const summary = await runDashboardRead(fixture, fetchSessionSummary("session:s1"));
        expect(summary).toMatchObject({ session_id: "s1", task: "Build it", last_assistant: "Done", turns: 2, tokens: 100, cost_usd: 0.5, model: "m1", tools: [{ name: "Read", count: 1 }] });
    });
});
