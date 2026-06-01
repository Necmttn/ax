import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { buildFileContextPack, extractFileContextSignals } from "./file-context.ts";

function fakeContextClient(): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string) =>
            Effect.sync(() => {
                if (sql.includes("FROM file")) {
                    return [[
                        { id: "file:f1", path: "src/ingest/codex.ts", repo: "ax", repository: "repository:ax" },
                        { id: "file:f2", path: "schema/schema.surql", repo: "ax", repository: "repository:ax" },
                    ]] as T;
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
                    ]] as T;
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
                    ]] as T;
                }
                if (sql.includes("FROM touched") && sql.includes("SELECT out.path")) {
                    return [[
                        { path: "package.json" },
                        { path: "package.json" },
                        { path: "src/ingest/codex.ts" },
                    ]] as T;
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
                    ]] as T;
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
                    ]] as T;
                }
                if (sql.includes("FROM edited")) {
                    return [[
                        {
                            session: "session:s1",
                            title: "can we fix ingest intent bug in codex transcript",
                            project: "ax",
                            source: "codex",
                            file: "src/ingest/codex.ts",
                            weight: 7,
                            last_seen: "2026-05-10T00:03:00.000Z",
                            started_at: "2026-05-10T00:00:00.000Z",
                            ended_at: "2026-05-10T00:20:00.000Z",
                            user_turns: 3,
                            assistant_turns: 8,
                            corrections: 1,
                            interruptions: 0,
                            hands_free_ms: 600_000,
                            produced_commits: 1,
                            delivery_status: "merged_to_main",
                            review_pain: "moderate",
                            pr_size: "small",
                            pr_title: "Fix Codex ingest intent",
                        },
                        {
                            session: "session:s1",
                            title: "can we fix ingest intent bug in codex transcript",
                            project: "ax",
                            source: "codex",
                            file: "schema/schema.surql",
                            weight: 2,
                            last_seen: "2026-05-10T00:03:00.000Z",
                            started_at: "2026-05-10T00:00:00.000Z",
                            ended_at: "2026-05-10T00:20:00.000Z",
                            user_turns: 3,
                            assistant_turns: 8,
                            corrections: 1,
                            interruptions: 0,
                            hands_free_ms: 600_000,
                            produced_commits: 1,
                            delivery_status: "merged_to_main",
                            review_pain: "moderate",
                            pr_size: "small",
                            pr_title: "Fix Codex ingest intent",
                        },
                    ]] as T;
                }
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
                    ]] as T;
                }
                return [[]] as T;
            }),
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

describe("file context signals", () => {
    test("combines prompt paths, file hints, errors, and symbols", () => {
        const signals = extractFileContextSignals(
            'Bug: "turn.intent_kind is missing" in classifyTurnIntent after src/ingest/codex.ts reingest',
            ["schema/schema.surql"],
        );

        expect(signals.paths).toEqual(["src/ingest/codex.ts", "schema/schema.surql"]);
        expect(signals.errors).toContain("turn.intent_kind is missing");
        expect(signals.symbols).toContain("intent_kind");
        expect(signals.symbols).toContain("classifyTurnIntent");
    });

    test("builds a compact pack with ranked user context and deduped evidence", async () => {
        const pack = await Effect.runPromise(
            buildFileContextPack({
                q: "fix ingest intent bug in src/ingest/codex.ts",
                files: ["schema/schema.surql"],
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, fakeContextClient()))),
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
            hands_free_ms: 600_000,
        });
        expect(pack.evidence.neighbor_files).toEqual([{ path: "package.json", count: 2 }]);
    });
});
