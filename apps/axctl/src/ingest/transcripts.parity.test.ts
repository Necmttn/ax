import { describe, expect, it } from "bun:test";
import {
    __testExtractClaudeJsonlLines,
    toClaudeNormalizedBatch,
} from "./transcripts.ts";
import { buildNormalizedTranscriptStatements } from "./normalized/transcripts.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";

/**
 * Richest claude fixture: a user task line, an assistant line carrying a
 * Skill + Bash + Edit + TodoWrite tool_use fan (skill relation, command tool,
 * edited-file evidence, plan snapshot), a user line whose FAILING tool_result
 * flips that turn's has_error (claude is the first parser exercising the
 * NormalizedTurnWrite hasError:true leg), and an isCompactSummary line that
 * becomes a compaction row + compaction provider event instead of a turn.
 */
const fixtureLines = (): string[] => [
    JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-10T09:00:00.000Z",
        cwd: "/Users/necmttn/Projects/ax",
        message: { role: "user", content: "fix the ingest bug" },
    }),
    JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-10T09:00:01.000Z",
        cwd: "/Users/necmttn/Projects/ax",
        message: {
            model: "claude-sonnet-4-5",
            content: [
                {
                    type: "tool_use",
                    id: "toolu_skill",
                    name: "Skill",
                    input: {
                        skill: "superpowers:test-driven-development",
                        reason: "Need TDD",
                    },
                },
                {
                    type: "tool_use",
                    id: "toolu_bash",
                    name: "Bash",
                    input: { command: "bun test apps/axctl" },
                },
                {
                    type: "tool_use",
                    id: "toolu_edit",
                    name: "Edit",
                    input: { file_path: "src/ingest/transcripts.ts" },
                },
                {
                    type: "tool_use",
                    id: "toolu_todo",
                    name: "TodoWrite",
                    input: {
                        todos: [
                            {
                                content: "Inspect schema",
                                activeForm: "Inspecting schema",
                                status: "in_progress",
                            },
                        ],
                    },
                },
            ],
        },
    }),
    JSON.stringify({
        type: "user",
        uuid: "u2",
        timestamp: "2026-06-10T09:00:02.000Z",
        message: {
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "toolu_bash",
                    is_error: true,
                    content: "1 test failed",
                },
            ],
        },
    }),
    JSON.stringify({
        type: "user",
        uuid: "u3",
        timestamp: "2026-06-10T09:00:03.000Z",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "## Summary\nGoal: ship X" },
    }),
];

describe("claude normalized-batch parity", () => {
    it("new single-batch path emits golden statement shapes", () => {
        const extracted = __testExtractClaudeJsonlLines(
            fixtureLines(),
            "-Users-necmttn-Projects-ax",
            "claude-parity-session",
        );
        expect(extracted).not.toBeNull();
        // Fixture-coverage guards: every claude parity leg must stay non-empty
        // so fixture drift can't silently shrink coverage.
        expect(extracted!.turns.length).toBeGreaterThan(0);
        expect(extracted!.providerEvents.length).toBeGreaterThan(0);
        expect(extracted!.toolCalls.length).toBeGreaterThan(0);
        expect(extracted!.skillRelations.length).toBeGreaterThan(0);
        expect(extracted!.planSnapshots.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
        // hasError leg: the failing tool_result turn must be present alongside
        // clean turns - claude is the first parser writing has_error: true.
        expect(extracted!.turns.some((turn) => turn.has_error)).toBe(true);
        expect(extracted!.turns.some((turn) => !turn.has_error)).toBe(true);

        const statements = buildNormalizedTranscriptStatements(
            toClaudeNormalizedBatch(extracted!, extracted!.skillRelations),
        );
        const sql = statements.join("\n");
        expect(sql).toContain("UPSERT agent_provider:`claude`");
        expect(sql).toMatch(/UPSERT agent_session:`claude__claude_parity_session__[^`]+`/);
        expect(sql).toMatch(/DELETE \(SELECT VALUE id FROM agent_event_child WHERE agent_session = agent_session:`claude__claude_parity_session__[^`]+`\)/);
        expect(sql).toMatch(/UPSERT agent_event:`claude__claude_parity_session__[^`]+__/);
        const turnStatements = statements.filter((statement) => statement.startsWith("UPSERT turn:"));
        expect(turnStatements.length).toBe(extracted!.turns.length);
        expect(turnStatements.some((statement) => statement.includes("has_error: true"))).toBe(true);
        expect(turnStatements.some((statement) => statement.includes("has_error: false"))).toBe(true);
        expect(turnStatements.some((statement) => statement.includes("agent_event"))).toBe(false);
        expect(sql).toContain("UPSERT tool:`claude__");
        expect(sql).toContain("UPSERT tool_call:`");
        expect(sql).toContain("UPSERT file:`");
        expect(sql).toMatch(/RELATE turn:`[^`]+`->edited:`[^`]+`->file:`[^`]+` SET /);
        expect(sql).toMatch(/RELATE tool_call:`[^`]+`->concerns:`[^`]+`->skill:`[^`]+` SET /);
        expect(sql).toContain("UPSERT plan:`");
        expect(sql).toContain("UPSERT plan_snapshot:`");
        expect(statements.some((statement) => statement.startsWith("UPSERT compaction:"))).toBe(true);
    });
});
