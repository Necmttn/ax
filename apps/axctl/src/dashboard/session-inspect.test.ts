import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { codexContentToInspectorText, fetchSessionInspect, jsonlBlockToInspectorText, parseClaudeLine, parseCodexLine, shareTurnToolCallToDto } from "./session-inspect.ts";
import type { ShareTurnToolCall } from "../share/session-share-queries.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session-inspect", { requireFts: true });

describe("graph tool_calls mapping (shareTurnToolCallToDto)", () => {
    test("maps a recorded Bash tool_call row to a ToolCallDto, parsing input_json + carrying output", () => {
        const row: ShareTurnToolCall = {
            seq: 11,
            name: "Bash",
            command: "gh pr list",
            input_json: JSON.stringify({ command: "gh pr list", description: "list PRs" }),
            output: "open PRs:\n#116",
            has_error: false,
        };
        const dto = shareTurnToolCallToDto(row);
        expect(dto.seq).toBe(11);
        expect(dto.name).toBe("Bash");
        expect(dto.category).toBe("sh");
        expect(dto.input).toEqual({ command: "gh pr list", description: "list PRs" });
        expect(dto.command).toBe("gh pr list");
        expect(dto.output_excerpt).toBe("open PRs:\n#116");
        expect(dto.has_error).toBe(false);
        expect(dto.tokens).toBeNull();
    });

    test("degrades to null input when input_json is absent or malformed; preserves error flag", () => {
        const row: ShareTurnToolCall = {
            seq: 24,
            name: "WebFetch",
            command: null,
            input_json: "not-json",
            output: null,
            has_error: true,
        };
        const dto = shareTurnToolCallToDto(row);
        expect(dto.input).toBeNull();
        expect(dto.command).toBeNull();
        expect(dto.output_excerpt).toBeNull();
        expect(dto.has_error).toBe(true);
        expect(dto.category).toBe("net");
    });
});

describe("live tool_calls extraction", () => {
    test("Claude tool_use block becomes a ToolCallDto and is NOT baked into text", () => {
        const line = JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-09T02:15:20Z",
            message: { role: "assistant", content: [
                { type: "tool_use", name: "WebFetch", input: { url: "https://paxel.ai/about" } },
            ] },
        });
        const turn = parseClaudeLine(line);
        // Pure tool_use turn: kept (non-null) with empty text + structured call.
        expect(turn).not.toBeNull();
        expect(turn!.text).toBe("");
        expect(turn!.text).not.toContain("<tool_use");
        expect(turn?.toolCalls?.length).toBe(1);
        const call = turn!.toolCalls![0]!;
        expect(call.name).toBe("WebFetch");
        expect(call.category).toBe("net");
        expect(call.input).toEqual({ url: "https://paxel.ai/about" });
        expect(call.command).toBeNull();
        expect(call.has_error).toBe(false);
    });

    test("Claude assistant prose + tool_use keeps the prose but drops the <tool_use> text", () => {
        const line = JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-09T02:15:20Z",
            message: { role: "assistant", content: [
                { type: "text", text: "Let me fetch that page." },
                { type: "tool_use", name: "WebFetch", input: { url: "https://paxel.ai/about" } },
            ] },
        });
        const turn = parseClaudeLine(line);
        expect(turn).not.toBeNull();
        expect(turn!.text).toBe("Let me fetch that page.");
        expect(turn!.text).not.toContain("<tool_use");
        expect(turn?.toolCalls?.length).toBe(1);
        expect(turn!.toolCalls![0]!.name).toBe("WebFetch");
    });

    test("Codex function_call becomes a ToolCallDto with empty text (not null)", () => {
        const line = JSON.stringify({
            timestamp: "2026-06-09T02:15:20Z",
            payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"ls -la\"}", call_id: "c1" },
        });
        const turn = parseCodexLine(line);
        expect(turn).not.toBeNull();
        expect(turn!.text).toBe("");
        expect(turn!.text).not.toContain("<tool_use");
        expect(turn?.toolCalls?.length).toBe(1);
        const call = turn!.toolCalls![0]!;
        expect(call.name).toBe("shell");
        expect(call.category).toBe("sh");
        expect(call.input).toEqual({ command: "ls -la" });
    });
});

describe("codexContentToInspectorText", () => {
    test("joins text blocks with newlines to match ingested turn offsets", () => {
        const text = codexContentToInspectorText([
            { type: "input_text", text: "<skills_instructions>x</skills_instructions>" },
            { type: "input_text", text: "<plugins_instructions>y</plugins_instructions>" },
        ]);

        expect(text).toBe("<skills_instructions>x</skills_instructions>\n<plugins_instructions>y</plugins_instructions>");
    });

    test("ignores non-text content blocks", () => {
        const text = codexContentToInspectorText([
            { type: "input_text", text: "before" },
            { type: "image", text: "ignored" },
            { type: "output_text", text: "after" },
        ]);

        expect(text).toBe("before\nafter");
    });
});

describe("jsonlBlockToInspectorText", () => {
    test("preserves Claude task notifications inside tool_result blocks", () => {
        const text = [
            "<task-notification>",
            "<task-id>abc</task-id>",
            "<status>completed</status>",
            "<summary>Agent completed</summary>",
            "</task-notification>",
        ].join("\n");

        expect(jsonlBlockToInspectorText({
            type: "tool_result",
            content: [{ type: "text", text }],
        })).toBe(text);
    });

    test("keeps ordinary tool results in the local-command wrapper", () => {
        expect(jsonlBlockToInspectorText({
            type: "tool_result",
            content: "done",
        })).toBe("<local-command-stdout>done</local-command-stdout>");
    });
});

describe("fetchSessionInspect graph-backed paging", () => {
    dtest("returns a paged inspect payload without locating or reading the transcript", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-inspect-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("session", [
                        { id: "session-a", project: "repo", cwd: "/repo", source: "codex" },
                    ]);
                    yield* w.putMany("session_health", [
                        { id: "sh1", session: "session-a", source: "codex", turns: 2 },
                    ]);
                    yield* w.putMany("turn", [
                        {
                            id: "t1",
                            session: "session-a",
                            seq: 1,
                            role: "user",
                            ts: new Date("2026-06-09T00:00:00.000Z"),
                            text: "hello inspect",
                        },
                        {
                            id: "t2",
                            session: "session-a",
                            seq: 2,
                            role: "assistant",
                            ts: new Date("2026-06-09T00:00:01.000Z"),
                            text: "done",
                        },
                    ]);
                }),
            ),
        );

        const payload = await Effect.runPromise(
            fetchSessionInspect("session-a", { turnOffset: 0, turnLimit: 100 }).pipe(
                Effect.provide(
                    Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), BunFsLayer),
                ),
            ),
        );

        // The graph-backed path is taken: source_path is the graph placeholder,
        // never the JSONL transcript path (there is no raw_file to fall back to
        // and no on-disk transcript for this test's fake session id).
        expect(payload.source_path).toBe("graph:session-a");
        expect(payload.total_turns).toBe(2);
        expect(payload.total_chars).toBe(17);
        expect(payload.turns.map((turn) => [turn.seq, turn.role, turn.raw_text])).toEqual([
            [0, "user", "hello inspect"],
            [1, "assistant", "done"],
        ]);
    });

    dtest("returns tool calls for a requested turn after the first 4,000 calls", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-inspect-tools-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.put("session", { id: "session-tools", source: "codex" });
                    yield* w.put("session_health", {
                        id: "sh-tools",
                        session: "session-tools",
                        source: "codex",
                        turns: 4001,
                    });
                    yield* w.put("turn", {
                        id: "turn-4001",
                        session: "session-tools",
                        seq: 4001,
                        role: "assistant",
                        ts: new Date("2026-06-09T00:00:01.000Z"),
                        text: "late tool call",
                    });
                    yield* w.putMany("tool_call", Array.from({ length: 4001 }, (_, index) => ({
                        id: `call-${index + 1}`,
                        session: "session-tools",
                        turn: index === 4000 ? "turn-4001" : null,
                        name: "Read",
                        ts: new Date("2026-06-09T00:00:01.000Z"),
                        seq: index + 1,
                        input_json: JSON.stringify({ file_path: `/tmp/${index + 1}` }),
                    })));
                }),
            ),
        );

        const payload = await Effect.runPromise(
            fetchSessionInspect("session-tools", { turnOffset: 4000, turnLimit: 1 }).pipe(
                Effect.provide(Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), BunFsLayer)),
            ),
        );

        expect(payload.turns).toHaveLength(1);
        expect(payload.turns[0]?.tool_calls?.map((call) => call.name)).toEqual(["Read"]);
    });

    dtest("reports full-session totals when the response contains one turn", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-inspect-totals-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.put("session", { id: "session-totals", source: "codex" });
                    yield* w.put("session_health", {
                        id: "sh-totals",
                        session: "session-totals",
                        source: "codex",
                        turns: 2,
                    });
                    yield* w.putMany("turn", [
                        {
                            id: "totals-turn-1",
                            session: "session-totals",
                            seq: 1,
                            role: "user",
                            ts: new Date("2026-06-09T00:00:00.000Z"),
                            text: "12345",
                        },
                        {
                            id: "totals-turn-2",
                            session: "session-totals",
                            seq: 2,
                            role: "assistant",
                            ts: new Date("2026-06-09T00:00:01.000Z"),
                            text: "67890",
                        },
                    ]);
                }),
            ),
        );

        const payload = await Effect.runPromise(
            fetchSessionInspect("session-totals", { turnOffset: 0, turnLimit: 1 }).pipe(
                Effect.provide(Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), BunFsLayer)),
            ),
        );

        expect(payload.turns).toHaveLength(1);
        expect(payload.total_chars).toBe(10);
        expect(payload.totals_by_kind).toEqual({ user_input: 5, assistant_text: 5 });
    });

    dtest("does not tag a later user turn as the subagent task", async () => {
        const task = "A".repeat(100);
        const laterUserInput = "B".repeat(120);
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-inspect-subagent-page-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.put("session", { id: "child", source: "codex-subagent" });
                    yield* w.put("session_health", {
                        id: "child-health",
                        session: "child",
                        source: "codex-subagent",
                        turns: 3,
                    });
                    yield* w.put("spawned", {
                        id: "parent-child",
                        in_id: "parent",
                        out_id: "child",
                    });
                    yield* w.putMany("turn", [
                        {
                            id: "task",
                            session: "child",
                            seq: 1,
                            role: "user",
                            text: task,
                            ts: new Date("2026-08-21T00:00:00Z"),
                        },
                        {
                            id: "answer",
                            session: "child",
                            seq: 2,
                            role: "assistant",
                            text: "ok",
                            ts: new Date("2026-08-21T00:00:01Z"),
                        },
                        {
                            id: "follow-up",
                            session: "child",
                            seq: 3,
                            role: "user",
                            text: laterUserInput,
                            ts: new Date("2026-08-21T00:00:02Z"),
                        },
                    ]);
                }),
            ),
        );

        const payload = await Effect.runPromise(
            fetchSessionInspect("child", { turnOffset: 2, turnLimit: 1 }).pipe(
                Effect.provide(Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), BunFsLayer)),
            ),
        );

        expect(payload.turns[0]?.semantic_role).toBe("user_input");
        expect(payload.totals_by_kind.subagent_task).toBe(task.length);
        expect(payload.totals_by_kind.user_input).toBe(laterUserInput.length);
    });
});
