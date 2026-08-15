import { beforeEach, describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { _resetBaselineCacheForTests } from "./session-baselines.ts";
import { fetchSessionChildren, fetchSessionsList } from "./sessions-list.ts";
import { publishDashboardFixture, runDashboardRead } from "./testing/duckdb.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("sessions list");
beforeEach(_resetBaselineCacheForTests);

describe("sessions list", () => {
    dtest("lists only roots and enriches them from aggregate tables", async () => {
        const t = new Date();
        const fixture = await publishDashboardFixture(tempDir("ax-sessions-list-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.putMany("session", [
                { id: "root", source: "claude", project: "ax", started_at: t, ended_at: null, raw_file: "transcripts:/root.jsonl" },
                { id: "child", source: "claude-subagent", project: "ax", started_at: new Date(t.getTime() + 1000), ended_at: null, raw_file: null },
                { id: "other", source: "codex", project: "other", started_at: new Date(t.getTime() - 1000), ended_at: t, raw_file: null },
            ]);
            yield* db.put("spawned", { id: "sp1", in_id: "root", out_id: "child", ts: t });
            yield* db.put("session_health", { id: "h1", session: "root", source: "claude", turns: 8, tool_errors: 1, user_corrections: 2, ts: t });
            yield* db.put("session_token_usage", { id: "u1", session: "root", source: "claude", estimated_tokens: 100, transcript_bytes: 1, estimated_cost_usd: 2.5, burn_buckets: "[10,20]", ts: t });
            yield* db.put("session_metrics", { id: "m1", session: "root", produced_commits: 2, reverted_commits: 1, lines_added: 30, lines_removed: 4, ts: t });
        }));
        const result = await runDashboardRead(fixture, fetchSessionsList({ project: "ax" }));
        expect(result.total_count).toBe(1);
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ id: "root", direct_children_count: 1, turn_count: 8, cost_usd: 2.5, burn_buckets: [10, 20], friction: 3, produced_commits: 2 });
        expect(result.sessions[0]?.started_at).toBe(t.toISOString());

        const children = await runDashboardRead(fixture, fetchSessionChildren("root"));
        expect(children.parent_session).toBe("root");
        expect(children.children.map((row) => row.id)).toEqual(["child"]);
    });

    dtest("binds filter values that contain quotes", async () => {
        const fixture = await publishDashboardFixture(tempDir("ax-sessions-quote-"), dylibPath, (db) =>
            db.put("session", { id: "quoted", source: "claude", project: "user's repo", started_at: new Date() }));
        const result = await runDashboardRead(fixture, fetchSessionsList({ project: "user's repo" }));
        expect(result.sessions.map((row) => row.id)).toEqual(["quoted"]);
    });
});
