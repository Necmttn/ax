import { describe, expect, test } from "bun:test";
import type { InspectTurnDto, ToolCallDto } from "@ax/lib/shared/dashboard-types";
import { callKey, pairToolResults } from "./tool-pairing.ts";

const toolCall = (over: Partial<ToolCallDto> = {}): ToolCallDto => ({
    seq: 0,
    name: "Bash",
    category: "sh",
    input: null,
    command: "ls",
    output_excerpt: null,
    has_error: false,
    tokens: null,
    ...over,
});

const callTurn = (seq: number, calls: ToolCallDto[]): InspectTurnDto => ({
    seq,
    role: "assistant",
    semantic_role: "tool_use",
    ts: null,
    char_count: 0,
    raw_text: "",
    spans: [],
    token_usage: null,
    content: null,
    tool_calls: calls,
});

const resultTurn = (seq: number, text: string): InspectTurnDto => ({
    seq,
    role: "user",
    semantic_role: "tool_result",
    ts: null,
    char_count: text.length,
    raw_text: text,
    spans: [],
    token_usage: null,
    content: null,
});

const textTurn = (seq: number): InspectTurnDto => ({
    seq,
    role: "assistant",
    semantic_role: "assistant_text",
    ts: null,
    char_count: 5,
    raw_text: "hello",
    spans: [],
    token_usage: null,
    content: null,
});

const skillContextTurn = (seq: number, text: string): InspectTurnDto => ({
    seq,
    role: "user",
    semantic_role: "skill_context",
    ts: null,
    char_count: text.length,
    raw_text: text,
    spans: [],
    token_usage: null,
    content: null,
});

const skillCall = (over: Partial<ToolCallDto> = {}): ToolCallDto =>
    toolCall({ name: "Skill", category: "other", input: { skill: "superpowers:brainstorming" }, command: null, ...over });

describe("pairToolResults", () => {
    test("one call + one result pairs", () => {
        const turns = [callTurn(1, [toolCall()]), resultTurn(2, "out-A")];
        const { resultByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.get(callKey(1, 0))).toBe("out-A");
        expect([...consumedResultSeqs]).toEqual([2]);
    });

    test("two calls + two results pair in order", () => {
        const turns = [
            callTurn(1, [toolCall({ name: "Read" }), toolCall({ name: "Bash" })]),
            resultTurn(2, "out-Read"),
            resultTurn(3, "out-Bash"),
        ];
        const { resultByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.get(callKey(1, 0))).toBe("out-Read");
        expect(resultByCall.get(callKey(1, 1))).toBe("out-Bash");
        expect(consumedResultSeqs.has(2)).toBe(true);
        expect(consumedResultSeqs.has(3)).toBe(true);
    });

    test("a call with no following result yields no pairing", () => {
        const turns = [callTurn(1, [toolCall()]), textTurn(2)];
        const { resultByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.has(callKey(1, 0))).toBe(false);
        expect(consumedResultSeqs.size).toBe(0);
    });

    test("standalone result with no preceding call is NOT consumed (orphan)", () => {
        const turns = [textTurn(1), resultTurn(2, "orphan-out")];
        const { resultByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.size).toBe(0);
        expect(consumedResultSeqs.size).toBe(0);
    });

    test("only the immediately-following consecutive results are consumed", () => {
        // K=2 calls but only one result follows before a non-result turn:
        // pairing stops at the gap, the second call stays unpaired.
        const turns = [
            callTurn(1, [toolCall(), toolCall()]),
            resultTurn(2, "out-1"),
            textTurn(3),
            resultTurn(4, "later-orphan"),
        ];
        const { resultByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.get(callKey(1, 0))).toBe("out-1");
        expect(resultByCall.has(callKey(1, 1))).toBe(false);
        expect(consumedResultSeqs.has(2)).toBe(true);
        expect(consumedResultSeqs.has(4)).toBe(false);
    });

    test("Skill call + launch result + skill_context consumes BOTH and maps the SKILL.md", () => {
        const turns = [
            callTurn(1, [skillCall()]),
            resultTurn(2, "<local-command-stdout>Launching skill: superpowers:brainstorming</local-command-stdout>"),
            skillContextTurn(3, "# Brainstorming\nfull SKILL.md body"),
            textTurn(4),
        ];
        const { resultByCall, skillContentByCall, consumedResultSeqs } = pairToolResults(turns);
        // launch line still pairs as the normal result...
        expect(resultByCall.get(callKey(1, 0))).toContain("Launching skill");
        // ...and the skill_context body folds in as the call's skill content.
        expect(skillContentByCall.get(callKey(1, 0))).toBe("# Brainstorming\nfull SKILL.md body");
        expect(consumedResultSeqs.has(2)).toBe(true);
        expect(consumedResultSeqs.has(3)).toBe(true);
        expect(consumedResultSeqs.has(4)).toBe(false);
    });

    test("Skill call with skill_context but NO launch result still folds the content", () => {
        const turns = [callTurn(1, [skillCall()]), skillContextTurn(2, "skill-body")];
        const { skillContentByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(skillContentByCall.get(callKey(1, 0))).toBe("skill-body");
        expect(consumedResultSeqs.has(2)).toBe(true);
    });

    test("a skill_context with no preceding Skill call is NOT consumed (orphan)", () => {
        const turns = [textTurn(1), skillContextTurn(2, "orphan-skill")];
        const { skillContentByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(skillContentByCall.size).toBe(0);
        expect(consumedResultSeqs.size).toBe(0);
    });

    test("skill_context separated from the Skill call by prose is left standalone", () => {
        const turns = [
            callTurn(1, [skillCall()]),
            resultTurn(2, "launch"),
            textTurn(3),
            skillContextTurn(4, "not-attributable"),
        ];
        const { skillContentByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(skillContentByCall.size).toBe(0);
        // only the launch tool_result was consumed, never the detached content.
        expect(consumedResultSeqs.has(4)).toBe(false);
    });

    test("a Skill call with no following skill_context still works (only result pairs)", () => {
        const turns = [callTurn(1, [skillCall()]), resultTurn(2, "launch-only"), textTurn(3)];
        const { resultByCall, skillContentByCall, consumedResultSeqs } = pairToolResults(turns);
        expect(resultByCall.get(callKey(1, 0))).toBe("launch-only");
        expect(skillContentByCall.size).toBe(0);
        expect([...consumedResultSeqs]).toEqual([2]);
    });
});
