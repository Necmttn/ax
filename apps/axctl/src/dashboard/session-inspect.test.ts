import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { codexContentToInspectorText, fetchSessionInspect, jsonlBlockToInspectorText, parseClaudeLine, parseCodexLine, shareTurnToolCallToDto } from "./session-inspect.ts";
import type { ShareTurnToolCall } from "../queries/session-detail.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

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

function makeInspectDb(): { readonly db: SurrealClientShape; readonly sql: string[] } {
    const tc = makeTestSurrealClient({
        denyWrites: true,
        fallback: (statement) => {
            if (statement.includes("FROM spawned") && statement.includes("WHERE out")) {
                return [[ ]];
            }
            if (statement.includes("SELECT project, cwd, raw_file, source FROM session")) {
                return [[
                    { project: "repo", cwd: "/repo", raw_file: "/slow/transcript.jsonl", source: "codex" },
                ]];
            }
            if (statement.includes("FROM spawned") && statement.includes("WHERE in")) {
                return [[ ]];
            }
            if (statement.includes("FROM hook_fire")) {
                return [[ ]];
            }
            if (statement.includes("FROM session_token_usage")) {
                return [[ ]];
            }
            if (statement.includes("FROM turn_token_usage")) {
                return [[ ]];
            }
            if (statement.includes("SELECT source_ref, type::string(id) AS document_id")) {
                return [[ ]];
            }
            if (statement.includes("FROM session_health:")) {
                return [[
                    { turns: 2 },
                ]];
            }
            if (statement.includes("FROM [turn:")) {
                return [[
                    {
                        seq: 1,
                        role: "user",
                        ts: "2026-06-09T00:00:00.000Z",
                        text: "hello inspect",
                    },
                    {
                        seq: 2,
                        role: "assistant",
                        ts: "2026-06-09T00:00:01.000Z",
                        text: "done",
                    },
                ]];
            }
            return [[ ]];
        },
    });
    return { db: tc.client, sql: tc.captured };
}

describe("fetchSessionInspect graph-backed paging", () => {
    test("returns a paged inspect payload without locating or reading the transcript", async () => {
        const { db, sql } = makeInspectDb();

        const payload = await Effect.runPromise(
            fetchSessionInspect("session-a", { turnOffset: 0, turnLimit: 100 }).pipe(
                Effect.provideService(SurrealClient, db),
                Effect.provide(BunFsLayer),
            ),
        );

        expect(payload.source_path).toBe("/slow/transcript.jsonl");
        expect(payload.total_turns).toBe(2);
        expect(payload.total_chars).toBe(17);
        expect(payload.turns.map((turn) => [turn.seq, turn.role, turn.raw_text])).toEqual([
            [0, "user", "hello inspect"],
            [1, "assistant", "done"],
        ]);
        expect(sql.some((statement) => statement.includes("SELECT raw_file FROM"))).toBe(false);
        expect(sql.some((statement) => statement.includes("GROUP ALL"))).toBe(false);
        expect(sql.some((statement) => statement.includes("START $offset LIMIT $limit"))).toBe(false);
    });
});
