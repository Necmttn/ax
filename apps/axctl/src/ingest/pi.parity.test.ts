import { describe, expect, it } from "bun:test";
import { __testExtractPiJsonlLines, toPiNormalizedBatch } from "./pi.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";

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
                { type: "toolCall", id: "call-2", name: "read", input: { path: "README.md" } },
            ],
        },
    }),
    JSON.stringify({ type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-06-10T06:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "total 8" }] } }),
    JSON.stringify({ type: "message", id: "result-2", parentId: "result-1", timestamp: "2026-06-10T06:00:03.500Z", message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "# ax" }] } }),
    JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "result-2", timestamp: "2026-06-10T06:00:04.000Z", summary: "compacted history" }),
];


describe("pi normalized-batch parity", () => {
    it("maps the rich extract to every normalized writer collection", () => {
        const extracted = __testExtractPiJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        const batch = toPiNormalizedBatch(extracted!);
        expect(batch.providers[0]).toMatchObject({ name: "pi", version: "3" });
        expect(batch.sessions[0]).toMatchObject({ id: "pi-parity", model: "gpt-5.5" });
        expect(batch.events.length).toBe(extracted!.providerEvents.length);
        expect(batch.turns.length).toBeGreaterThan(0);
        expect(batch.toolCalls).toHaveLength(2);
        expect(batch.toolFileEvidence.length).toBeGreaterThan(0);
        expect(batch.syntheticSkillInvocations.length).toBeGreaterThan(0);
        expect(batch.toolCallSkillRelations.length).toBeGreaterThan(0);
        expect(batch.compactions.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
    });
});
