import { describe, expect, it } from "bun:test";
import { __legacyBuildPiBatchStatements, __testBuildPiBatchStatements, __testExtractPiJsonlLines } from "./pi.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

const fixtureLines = (): string[] => [
    JSON.stringify({ type: "session", version: 3, id: "pi-parity", timestamp: "2026-06-10T06:00:00.000Z", cwd: "/Users/necmttn/Projects/ax" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-06-10T06:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "list files" }] } }),
    JSON.stringify({
        type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-06-10T06:00:02.000Z",
        message: {
            role: "assistant", model: "gpt-5.5", provider: "openai-codex",
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 },
            content: [
                { type: "text", text: "Listing." },
                { type: "toolCall", id: "call-1", name: "exec_command", input: { command: "ls -la" } },
            ],
        },
    }),
    JSON.stringify({ type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-06-10T06:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "total 8" }] } }),
    JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "result-1", timestamp: "2026-06-10T06:00:04.000Z", summary: "compacted history" }),
];

describe("pi normalized-batch parity", () => {
    it("new path emits the exact legacy statement multiset", () => {
        const extracted = __testExtractPiJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        expect(extracted!.toolCalls.length).toBe(1);
        // Fixture-coverage guards: synthetic-invocation and compaction parity
        // coverage must not silently shrink if the fixture drifts.
        expect(extracted!.invocations.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);
        const legacy = __legacyBuildPiBatchStatements(extracted!);
        const next = __testBuildPiBatchStatements(extracted!);
        expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
    });
});
