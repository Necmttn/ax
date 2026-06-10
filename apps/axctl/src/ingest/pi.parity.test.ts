import { describe, expect, it } from "bun:test";
import { __testBuildPiBatchStatements, __testExtractPiJsonlLines } from "./pi.ts";
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
    it("new path emits golden statement shapes", () => {
        const extracted = __testExtractPiJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        expect(extracted!.toolCalls.length).toBe(2);
        // Fixture-coverage guards: synthetic-invocation, compaction, and
        // tool-file-evidence parity coverage must not silently shrink if the
        // fixture drifts.
        expect(extracted!.invocations.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
        const statements = __testBuildPiBatchStatements(extracted!);
        const sql = statements.join("\n");
        expect(sql).toContain("UPSERT agent_provider:`pi`");
        expect(sql).toMatch(/UPSERT agent_session:`pi__pi_parity__[^`]+`/);
        expect(sql).toMatch(/UPSERT agent_event:`pi__pi_parity__[^`]+__/);
        expect(sql).toMatch(/UPSERT turn:`[^`]+` CONTENT \{ session: session:`pi-parity`, agent_event: agent_event:`pi__pi_parity__/);
        expect(sql).toContain("UPSERT tool:`pi__");
        expect(sql).toContain("UPSERT tool_call:`");
        expect(sql).toContain("UPSERT file:`");
        expect(sql).toMatch(/RELATE tool_call:`[^`]+`->(read_file|mentioned_file):`[^`]+`->file:`[^`]+` SET /);
        expect(sql).toContain('scope: "pi-tool", dir_path: "(synthetic)", content_hash: "pi"');
        expect(sql).toMatch(/RELATE turn:`[^`]+`->invoked:`[^`]+`->skill:`[^`]+` SET session = session:`pi-parity`/);
        expect(statements.some((statement) => statement.startsWith("UPSERT compaction:"))).toBe(true);
        expect(sql).toContain("UPSERT session_token_usage:`pi_parity`");
    });
});
