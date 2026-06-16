import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { buildFileContextPack } from "./file-context-pack.ts";

// Lean prior-session loader: the pack composes the SAME single loader the hook
// uses. The stub answers its multi-query shape - an indexed `edited` aggregate,
// a refListSource session-meta fetch, and batched produced/delivery_outcome/
// session_health/turn reads - instead of the retired per-row-subquery loader.
function fakeContextLayer() {
    const turnCountRows = [
        ...Array.from({ length: 3 }, (_, i) => ({
            session: "session:s1",
            role: "user",
            intent_kind: i === 0 ? "correction" : "organic_task",
        })),
        ...Array.from({ length: 8 }, () => ({ session: "session:s1", role: "assistant", intent_kind: null })),
    ];
    return makeTestSurrealClient({
        denyWrites: true,
        fallback: (sql) => {
            if (sql.includes("FROM file")) {
                return [[
                    { id: "file:f1", path: "src/ingest/codex.ts", repo: "ax", repository: "repository:ax" },
                    { id: "file:f2", path: "schema/schema.surql", repo: "ax", repository: "repository:ax" },
                ]];
            }
            if (sql.includes("FROM read_file")) {
                return [[
                    {
                        kind: "read_file",
                        evidence: "command_norm:sed",
                        path_seen: "schema/schema.surql",
                        ts: "2026-05-10T00:00:00.000Z",
                        path: "schema/schema.surql",
                        tool_name: "exec_command",
                        command_norm: "sed",
                        turn: { seq: 7, intent_kind: "organic_task", session: { id: "session:s1", source: "codex" } },
                    },
                ]];
            }
            if (sql.includes("FROM searched_file")) {
                return [[
                    {
                        kind: "searched_file",
                        evidence: "command_norm:rg",
                        path_seen: "src/ingest/codex.ts",
                        ts: "2026-05-10T00:01:00.000Z",
                        path: "src/ingest/codex.ts",
                        tool_name: "exec_command",
                        command_norm: "rg",
                        turn: { seq: 8, intent_kind: "organic_task", session: { id: "session:s1", source: "codex" } },
                    },
                    {
                        kind: "searched_file",
                        evidence: "command_norm:rg",
                        path_seen: "src/ingest/codex.ts",
                        ts: "2026-05-10T00:02:00.000Z",
                        path: "src/ingest/codex.ts",
                        tool_name: "exec_command",
                        command_norm: "rg",
                        turn: { seq: 9, intent_kind: "organic_task", session: { id: "session:s1", source: "codex" } },
                    },
                ]];
            }
            if (sql.includes("FROM touched") && sql.includes("SELECT out.path")) {
                return [[
                    { path: "package.json" },
                    { path: "package.json" },
                    { path: "src/ingest/codex.ts" },
                ]];
            }
            if (sql.includes("FROM touched")) {
                return [[
                    {
                        id: "touched:e1",
                        ts: "2026-05-10T00:00:00.000Z",
                        file: { id: "file:f1", path: "src/ingest/codex.ts" },
                        commit: {
                            id: "commit:c1",
                            sha: "abc123456789",
                            message: "fix ingest intent",
                            sessions: [{ id: "session:s1", source: "codex", cwd: "/repo" }],
                        },
                    },
                    {
                        id: "touched:e2",
                        ts: "2026-05-10T00:00:01.000Z",
                        file: { id: "file:f2", path: "schema/schema.surql" },
                        commit: {
                            id: "commit:c1",
                            sha: "abc123456789",
                            message: "fix ingest intent",
                            sessions: [{ id: "session:s1", source: "codex", cwd: "/repo" }],
                        },
                    },
                ]];
            }
            if (sql.includes("FROM mentioned_file") || sql.includes("FROM mentioned_symbol") || sql.includes("FROM mentioned_error")) {
                return [[
                    {
                        id: "turn:tool",
                        session: "session:s1",
                        source: "codex",
                        seq: 10,
                        intent_kind: "tool_call",
                        text_excerpt: "",
                        score: 10,
                        why: "tool_output: src/ingest/codex.ts",
                    },
                    {
                        id: "turn:user",
                        session: "session:s1",
                        source: "codex",
                        seq: 2,
                        intent_kind: "preference",
                        text_excerpt: "please fix the ingest intent bug",
                        score: 8,
                        why: "text: src/ingest/codex.ts",
                    },
                ]];
            }
            // Lean prior-session loader: indexed edited aggregate (session/file/weight/last_seen).
            if (sql.includes("FROM edited")) {
                return [[
                    { session: "session:s1", file: "file:f1", weight: 7, last_seen: "2026-05-10T00:03:00.000Z" },
                    { session: "session:s1", file: "file:f2", weight: 2, last_seen: "2026-05-10T00:03:00.000Z" },
                ]];
            }
            if (sql.includes("FROM produced")) {
                return [[{ in: "session:s1" }]];
            }
            if (sql.includes("FROM delivery_outcome")) {
                return [[
                    {
                        session: "session:s1",
                        status: "merged_to_main",
                        review_pain: "moderate",
                        pr_size: "small",
                        pr_title: "Fix Codex ingest intent",
                    },
                ]];
            }
            if (sql.includes("FROM session_health")) {
                return [[{ session: "session:s1", interruptions: 0 }]];
            }
            // refListSource session-meta fetch: `FROM [session:s1].map(|$r| $r.*)...`
            if (sql.includes(".map(|$r| $r.")) {
                return [[
                    {
                        id: "session:s1",
                        project: "ax",
                        source: "codex",
                        started_at: "2026-05-10T00:00:00.000Z",
                        ended_at: "2026-05-10T00:20:00.000Z",
                    },
                ]];
            }
            // Lean per-session turn-count read.
            if (sql.includes("FROM turn") && sql.includes("role IN ['user','assistant']")) {
                return [turnCountRows];
            }
            // Lean per-session title read (single-quoted intent list).
            if (sql.includes("FROM turn") && sql.includes("intent_kind IN ['organic_task'")) {
                return [[
                    { session: "session:s1", text_excerpt: "can we fix ingest intent bug in codex transcript", seq: 2, intent_kind: "preference" },
                ]];
            }
            // loadProducedSessionTurns (message_kind = "task", double-quoted).
            if (sql.includes("FROM turn")) {
                return [[
                    {
                        id: "turn:old",
                        session: "session:s1",
                        source: "codex",
                        seq: 1,
                        ts: "2026-05-10T00:00:00.000Z",
                        message_kind: "task",
                        intent_kind: "organic_task",
                        text_excerpt: "unrelated old work",
                    },
                    {
                        id: "turn:relevant",
                        session: "session:s1",
                        source: "codex",
                        seq: 2,
                        ts: "2026-05-10T00:00:01.000Z",
                        message_kind: "task",
                        intent_kind: "preference",
                        text_excerpt: "can we fix ingest intent bug in codex transcript",
                    },
                ]];
            }
            return [[]];
        },
    }).layer;
}

describe("file context pack", () => {
    test("builds a compact pack with ranked user context and deduped evidence", async () => {
        const pack = await Effect.runPromise(
            buildFileContextPack({
                q: "fix ingest intent bug in src/ingest/codex.ts",
                files: ["schema/schema.surql"],
            }).pipe(Effect.provide(fakeContextLayer())),
        );

        expect(pack.files.map((file) => file.path)).toEqual(["src/ingest/codex.ts", "schema/schema.surql"]);
        expect(pack.evidence.tool_file).toHaveLength(2);
        expect(pack.evidence.mention_turns.map((turn) => turn.id)).toEqual(["turn:user"]);
        expect(pack.ai_context).toContain("can we fix ingest intent bug in codex transcript");
        expect(pack.ai_context).toContain("Prior sessions that edited these files:");
        expect(pack.ai_context).toContain("9 edits, 2 files, 1 commits, 3u/8a, 1 corrections, main, merged_to_main, moderate review");
        expect(pack.ai_context.match(/abc1234567/g)?.length).toBe(1);
        expect(pack.evidence.prior_file_sessions[0]).toMatchObject({
            session: "session:s1",
            weight: 9,
            files_touched: 2,
            produced_commits: 1,
            merged_to_main: true,
            corrections: 1,
            review_pain: "moderate",
            // Lean loader drops the unread `hands_free_ms` (was 600_000 under the
            // retired slow loader; no consumer reads it).
            hands_free_ms: null,
        });
        expect(pack.evidence.neighbor_files).toEqual([{ path: "package.json", count: 2 }]);
    });
});
