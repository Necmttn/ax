import { describe, expect, it } from "bun:test";
import {
    __testExtractClaudeJsonlLines,
    toClaudeNormalizedBatch,
} from "./transcripts.ts";
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
    it("maps the rich extract to every normalized writer collection", () => {
        const extracted = __testExtractClaudeJsonlLines(
            fixtureLines(), "-Users-necmttn-Projects-ax", "claude-parity-session",
        );
        expect(extracted).not.toBeNull();
        const batch = toClaudeNormalizedBatch(
            extracted!, extracted!.skillRelations, extracted!.invocations,
        );
        expect(batch.providers[0]).toMatchObject({ name: "claude" });
        expect(batch.sessions[0]).toMatchObject({ id: "claude-parity-session", model: "claude-sonnet-4-5" });
        expect(batch.events.length).toBe(extracted!.providerEvents.length);
        expect(batch.turns.length).toBeGreaterThan(0);
        expect(batch.turns.some((turn) => turn.hasError)).toBe(true);
        expect(batch.turns.some((turn) => !turn.hasError)).toBe(true);
        expect(batch.toolCalls.length).toBeGreaterThan(0);
        expect(batch.toolFileEvidence.length).toBeGreaterThan(0);
        expect(batch.syntheticSkillInvocations.length).toBeGreaterThan(0);
        expect(batch.toolCallSkillRelations.length).toBeGreaterThan(0);
        expect(batch.planSnapshots.length).toBeGreaterThan(0);
        expect(batch.compactions.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
    });

    it("carries session.raw_file as a top-level rawFile, not only inside `raw`", () => {
        // The normalized session write resolves `raw_file` as
        // `rawFile ?? sourcePath ?? null` and runs AFTER the claude stage's own
        // session upsert. When this field is missing, that later write silently
        // replaces the blob POINTER with the SOURCE PATH, and every snapshot on
        // disk becomes unreferenced - the reference-set shape blob GC deletes
        // (#854). A copy nested under `raw` is not enough; the writer never
        // reads it.
        const extracted = __testExtractClaudeJsonlLines(
            fixtureLines(), "-Users-necmttn-Projects-ax", "claude-parity-session",
        );
        expect(extracted).not.toBeNull();
        extracted!.session.raw_file = "transcripts:/claude-parity-session.jsonl";

        const batch = toClaudeNormalizedBatch(
            extracted!, extracted!.skillRelations, extracted!.invocations,
        );
        expect(batch.sessions[0]?.rawFile).toBe("transcripts:/claude-parity-session.jsonl");
    });
});
