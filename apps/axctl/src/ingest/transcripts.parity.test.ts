import { describe, expect, it } from "bun:test";
import {
    __testExtractClaudeJsonlLines,
    toClaudeNormalizedBatch,
} from "./transcripts.ts";
import { buildNormalizedTranscriptStatements } from "./normalized/transcripts.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";

const countStarting = (statements: readonly string[], prefix: string): number =>
    statements.filter((statement) => statement.startsWith(prefix)).length;

const countRelation = (statements: readonly string[], relation: string): number =>
    statements.filter((statement) => statement.includes(`->${relation}:`)).length;

const expectOneStatement = (
    statements: readonly string[],
    predicate: (statement: string) => boolean,
    label: string,
): string => {
    const matches = statements.filter(predicate);
    expect(matches.length, label).toBe(1);
    return matches[0]!;
};

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
        expect(countStarting(statements, "UPSERT agent_provider:")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_session:")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event_child")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event WHERE")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_event:")).toBe(extracted!.providerEvents.length);
        expect(countRelation(statements, "agent_event_child")).toBe(12);
        expect(countStarting(statements, "UPSERT turn:")).toBe(extracted!.turns.length);
        expect(countStarting(statements, "UPSERT tool:")).toBe(5);
        expect(countStarting(statements, "UPSERT tool_call:")).toBe(extracted!.toolCalls.length);
        expect(countStarting(statements, "UPSERT file:")).toBe(1);
        expect(countRelation(statements, "edited")).toBe(1);
        expect(countRelation(statements, "concerns")).toBe(extracted!.skillRelations.length);
        expect(countStarting(statements, "UPSERT plan:")).toBe(extracted!.planSnapshots.length);
        expect(countStarting(statements, "UPSERT plan_snapshot:")).toBe(extracted!.planSnapshots.length);
        expect(countStarting(statements, "UPSERT compaction:")).toBe(extracted!.compactions.length);

        expect(statements[0]).toBe('UPSERT agent_provider:`claude` MERGE { name: "claude", display_name: "Claude Code", version: NONE, capabilities: "{\\"transcripts\\":true,\\"toolCalls\\":true,\\"planSignals\\":{\\"provider\\":\\"claude\\",\\"status\\":\\"available\\",\\"planSources\\":[\\"claude_todowrite\\",\\"claude_task\\",\\"claude_sidecar_plan\\",\\"claude_sidecar_task\\"],\\"toolNames\\":[\\"TodoWrite\\",\\"TaskCreate\\",\\"TaskUpdate\\",\\"TaskGet\\",\\"TaskList\\"],\\"evidence\\":\\"Claude transcript tool_use and tool_result blocks expose TodoWrite todos and Task tool plan signals; Claude plans/tasks sidecars can also surface visible plan snapshots.\\"},\\"delegationSignals\\":{\\"provider\\":\\"claude\\",\\"status\\":\\"available\\",\\"rawSignals\\":[\\"subagents/agent-*.jsonl manifest\\"],\\"sharedRecords\\":[\\"spawned\\"],\\"evidence\\":\\"Claude subagent transcript manifests include parent session id and agent id; derive-claude-subagents writes spawned edges.\\"}}", updated_at: time::now() };');
        const sessionStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT agent_session:"), "claude agent_session row");
        expect(sessionStatement).toContain('provider_session_id: "claude-parity-session", ax_session: session:`claude-parity-session`');
        expect(sessionStatement).toContain('raw: "{\\"source\\":\\"claude_transcript\\",\\"rawFile\\":null}"');
        expect(sessionStatement).toContain('labels: "{\\"source\\":\\"transcript\\",\\"project\\":\\"-Users-necmttn-Projects-ax\\"}", metrics: "{\\"turns\\":3,\\"toolCalls\\":4,\\"providerEvents\\":9}"');
        expect(sql).toContain("UPSERT agent_provider:`claude`");
        expect(sql).toMatch(/UPSERT agent_session:`claude__claude_parity_session__[^`]+`/);
        expect(sql).toMatch(/DELETE \(SELECT VALUE id FROM agent_event_child WHERE agent_session = agent_session:`claude__claude_parity_session__[^`]+`\)/);
        expect(sql).toMatch(/UPSERT agent_event:`claude__claude_parity_session__[^`]+__/);
        const turnStatements = statements.filter((statement) => statement.startsWith("UPSERT turn:"));
        expect(turnStatements.length).toBe(extracted!.turns.length);
        expect(turnStatements.some((statement) => statement.includes("has_error: true"))).toBe(true);
        expect(turnStatements.some((statement) => statement.includes("has_error: false"))).toBe(true);
        expect(turnStatements.some((statement) => statement.includes("agent_event"))).toBe(false);
        expect(statements).toContain('UPSERT turn:`claude_parity_session__a13c8c7a3b0ef68e__seq_000003` CONTENT { session: session:`claude-parity-session`, seq: 3, ts: d"2026-06-10T09:00:02.000Z", role: "user", message_kind: "tool_result", intent_kind: "tool_result", text: NONE, text_excerpt: NONE, has_tool_use: false, has_error: true };');
        const bashToolCall = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT tool_call:") && statement.includes('name: "Bash"'), "claude Bash tool_call row");
        expect(bashToolCall).toContain('call_id: "toolu_bash", ts: d"2026-06-10T09:00:01.000Z", status: "error"');
        expect(bashToolCall).toContain('input_json: "{\\"command\\":\\"bun test apps/axctl\\"}", output_json: "1 test failed"');
        expect(bashToolCall).toContain('command_text: "bun test apps/axctl", command_norm: "bun test"');
        expect(statements).toContain('RELATE tool_call:`claude_parity_session__a13c8c7a3b0ef68e__toolu_skill__c6622b06af990813`->concerns:`5b837e18d32bd66e`->skill:`v2__superpowers_test_driven_development__6a86593eda518006` SET kind = "invoked_skill", ts = d"2026-06-10T09:00:01.000Z", labels = "{\\"provider\\":\\"claude\\",\\"toolName\\":\\"Skill\\",\\"source\\":\\"transcript\\"}", metrics = "{\\"turnSeq\\":2}", reason = "Claude Skill tool invocation";');
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
