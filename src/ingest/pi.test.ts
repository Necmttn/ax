import { describe, expect, test } from "bun:test";
import {
    agentEventRecordKey,
    buildAgentEventStatements,
} from "./provider-events.ts";
import { __testExtractPiJsonlLines, textFromPiContent } from "./pi.ts";

describe("Pi JSONL extraction", () => {
    test("textFromPiContent joins text blocks and ignores unknown blocks", () => {
        expect(textFromPiContent([
            { type: "text", text: "first" },
            { type: "thinking", thinking: "private chain" },
            { type: "toolCall", name: "bash" },
            { type: "text", text: "second" },
            { type: "image", url: "file:///tmp/image.png" },
        ])).toBe("first\nsecond");

        expect(textFromPiContent([{ type: "thinking", thinking: "hidden" }])).toBeNull();
    });

    test("extracts tree provider events, projected turns, model preference, and usage rollup", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-session",
                timestamp: "2026-05-29T06:00:00.000Z",
                cwd: "/Users/necmttn/Projects/ax",
            }),
            JSON.stringify({
                type: "model_change",
                id: "model-1",
                parentId: null,
                timestamp: "2026-05-29T06:00:01.000Z",
                provider: "openai-codex",
                modelId: "gpt-5.5",
            }),
            JSON.stringify({
                type: "custom",
                customType: "plannotator",
                data: { phase: "idle" },
                id: "custom-1",
                parentId: "model-1",
                timestamp: "2026-05-29T06:00:02.000Z",
            }),
            JSON.stringify({
                type: "message",
                id: "user-1",
                parentId: "custom-1",
                timestamp: "2026-05-29T06:00:03.000Z",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "Inspect the tree." },
                        { type: "unknown", value: "ignored" },
                    ],
                },
            }),
            JSON.stringify({
                type: "message",
                id: "assistant-1",
                parentId: "user-1",
                timestamp: "2026-05-29T06:00:04.000Z",
                message: {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "hidden" },
                        { type: "text", text: "I will inspect it." },
                    ],
                    provider: "openai-codex",
                    model: "gpt-5.5",
                    usage: {
                        input: 10,
                        output: 5,
                        cacheRead: 2,
                        cacheWrite: 3,
                        totalTokens: 20,
                    },
                },
            }),
            JSON.stringify({
                type: "model_change",
                id: "model-2",
                parentId: "assistant-1",
                timestamp: "2026-05-29T06:00:05.000Z",
                provider: "anthropic",
                modelId: "claude-opus-4-7",
            }),
            JSON.stringify({
                type: "message",
                id: "tool-result-1",
                parentId: "assistant-1",
                timestamp: "2026-05-29T06:00:06.000Z",
                message: {
                    role: "toolResult",
                    toolCallId: "call-read",
                    toolName: "read",
                    content: [{ type: "text", text: "file contents" }],
                    isError: false,
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.session).toMatchObject({
            id: "pi-session",
            version: 3,
            cwd: "/Users/necmttn/Projects/ax",
            started_at: "2026-05-29T06:00:00.000Z",
            ended_at: "2026-05-29T06:00:06.000Z",
            model: "claude-opus-4-7",
        });
        expect(extracted.usage).toEqual({
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 3,
            totalTokens: 20,
        });

        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                providerEventId: "model-1",
                parentProviderEventId: null,
                seq: 1,
                type: "model_change",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "custom-1",
                parentProviderEventId: "model-1",
                seq: 2,
                type: "custom",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "user-1",
                parentProviderEventId: "custom-1",
                seq: 3,
                type: "message",
                role: "user",
                textExcerpt: "Inspect the tree.",
            },
            {
                providerEventId: "assistant-1",
                parentProviderEventId: "user-1",
                seq: 4,
                type: "message",
                role: "assistant",
                textExcerpt: "I will inspect it.",
            },
            {
                providerEventId: "model-2",
                parentProviderEventId: "assistant-1",
                seq: 5,
                type: "model_change",
                role: null,
                textExcerpt: null,
            },
            {
                providerEventId: "tool-result-1",
                parentProviderEventId: "assistant-1",
                seq: 6,
                type: "message",
                role: "toolResult",
                textExcerpt: "file contents",
            },
        ]);

        expect(extracted.providerEvents[3]?.metrics).toMatchObject({
            turnSeq: 4,
            usage: {
                input: 10,
                output: 5,
                cacheRead: 2,
                cacheWrite: 3,
                totalTokens: 20,
            },
        });

        expect(extracted.turns.map((turn) => ({
            seq: turn.seq,
            role: turn.role,
            message_kind: turn.message_kind,
            intent_kind: turn.intent_kind,
            text: turn.text,
            has_tool_use: turn.has_tool_use,
            has_error: turn.has_error,
        }))).toEqual([
            {
                seq: 3,
                role: "user",
                message_kind: "task",
                intent_kind: "organic_task",
                text: "Inspect the tree.",
                has_tool_use: false,
                has_error: false,
            },
            {
                seq: 4,
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "assistant",
                text: "I will inspect it.",
                has_tool_use: false,
                has_error: false,
            },
            {
                seq: 6,
                role: "tool_result",
                message_kind: "tool_result",
                intent_kind: "tool_result",
                text: "file contents",
                has_tool_use: false,
                has_error: false,
            },
        ]);

        const statements = buildAgentEventStatements({
            sessions: [],
            events: extracted.providerEvents,
        });
        const customEventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-session",
            providerEventId: "custom-1",
            seq: 2,
        });
        const userEventKey = agentEventRecordKey({
            provider: "pi",
            providerSessionId: "pi-session",
            providerEventId: "user-1",
            seq: 3,
        });
        const edgeStatements = statements.filter((statement) =>
            statement.startsWith("RELATE agent_event:"),
        );

        expect(edgeStatements).toHaveLength(5);
        expect(edgeStatements.join("\n")).toContain(
            `RELATE agent_event:\`${customEventKey}\``,
        );
        expect(edgeStatements.join("\n")).toContain(`->agent_event:\`${userEventKey}\``);
    });
});
