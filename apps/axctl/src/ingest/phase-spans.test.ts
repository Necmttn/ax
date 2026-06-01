import { describe, expect, test } from "bun:test";
import { derivePhaseSpans, summarizeInteractionRhythm, type PhaseTurn } from "./phase-spans.ts";

const at = (minute: number): Date => new Date(Date.UTC(2026, 4, 15, 10, minute, 0));

describe("derivePhaseSpans", () => {
    test("returns no spans for empty input", () => {
        expect(derivePhaseSpans([])).toEqual([]);
    });

    test("returns a zero-duration span for single-turn input", () => {
        expect(derivePhaseSpans([
            { seq: 1, role: "user", ts: at(0), text: "Plan this change." },
        ])).toEqual([
            {
                phase: "planning",
                startSeq: 1,
                endSeq: 1,
                startTs: at(0),
                endTs: at(0),
                durationMs: 0,
                userTurns: 1,
                assistantTurns: 0,
                toolCalls: 0,
            },
        ]);
    });

    test("splits timeline across planning, implementation, verification, and finalization", () => {
        const turns: PhaseTurn[] = [
            { seq: 1, role: "user", ts: at(0), text: "Can you add phase timing?" },
            { seq: 2, role: "assistant", ts: at(1), text: "I will inspect the ingest shape first." },
            {
                seq: 3,
                role: "assistant",
                ts: at(2),
                toolCalls: [{ name: "exec_command", commandText: "rg \"durationMs\" src/ingest" }],
            },
            { seq: 4, role: "assistant", ts: at(4), toolCalls: [{ name: "apply_patch" }] },
            {
                seq: 5,
                role: "assistant",
                ts: at(8),
                toolCalls: [{ name: "exec_command", commandText: "bun test src/ingest/phase-spans.test.ts" }],
            },
            { seq: 6, role: "assistant", ts: at(10), text: "DONE changed files and verification." },
        ];

        expect(derivePhaseSpans(turns)).toEqual([
            {
                phase: "planning",
                startSeq: 1,
                endSeq: 2,
                startTs: at(0),
                endTs: at(2),
                durationMs: 2 * 60_000,
                userTurns: 1,
                assistantTurns: 1,
                toolCalls: 0,
            },
            {
                phase: "context_gathering",
                startSeq: 3,
                endSeq: 3,
                startTs: at(2),
                endTs: at(4),
                durationMs: 2 * 60_000,
                userTurns: 0,
                assistantTurns: 1,
                toolCalls: 1,
            },
            {
                phase: "implementation",
                startSeq: 4,
                endSeq: 4,
                startTs: at(4),
                endTs: at(8),
                durationMs: 4 * 60_000,
                userTurns: 0,
                assistantTurns: 1,
                toolCalls: 1,
            },
            {
                phase: "verification",
                startSeq: 5,
                endSeq: 5,
                startTs: at(8),
                endTs: at(10),
                durationMs: 2 * 60_000,
                userTurns: 0,
                assistantTurns: 1,
                toolCalls: 1,
            },
            {
                phase: "finalization",
                startSeq: 6,
                endSeq: 6,
                startTs: at(10),
                endTs: at(10),
                durationMs: 0,
                userTurns: 0,
                assistantTurns: 1,
                toolCalls: 0,
            },
        ]);
    });

    test("classifies apply_patch mentioning test coverage as implementation", () => {
        const turns: PhaseTurn[] = [
            {
                seq: 1,
                role: "assistant",
                ts: at(0),
                text: "Adding test coverage for the new branch.",
                toolCalls: [{
                    name: "apply_patch",
                    inputJson: { patch: "Add regression test coverage" },
                    outputExcerpt: "test output should not drive phase classification",
                    errorText: "test error text should not drive phase classification",
                }],
            },
        ];

        expect(derivePhaseSpans(turns)[0]?.phase).toBe("implementation");
    });

    test("classifies explicit final done text as finalization even with edit words", () => {
        expect(derivePhaseSpans([
            { seq: 1, role: "assistant", ts: at(0), text: "Done editing phase-spans.ts" },
        ])[0]?.phase).toBe("finalization");

        expect(derivePhaseSpans([
            { seq: 1, role: "assistant", ts: at(0), text: "final patch applied" },
        ])[0]?.phase).toBe("finalization");
    });
});

describe("summarizeInteractionRhythm", () => {
    test("returns zero counts and durations for empty input", () => {
        expect(summarizeInteractionRhythm([])).toEqual({
            totalDurationMs: 0,
            userTurns: 0,
            assistantTurns: 0,
            longestHandsFreeMs: 0,
            corrections: 0,
        });
    });

    test("returns single-turn counts with no hands-free duration", () => {
        expect(summarizeInteractionRhythm([
            { seq: 1, role: "user", ts: at(0), text: "Start this." },
        ])).toEqual({
            totalDurationMs: 0,
            userTurns: 1,
            assistantTurns: 0,
            longestHandsFreeMs: 0,
            corrections: 0,
        });
    });

    test("measures hands-free work between user turns", () => {
        const turns: PhaseTurn[] = [
            { seq: 1, role: "user", ts: at(0), text: "Start this task." },
            { seq: 2, role: "assistant", ts: at(5), toolCalls: [{ name: "exec_command", commandText: "rg phase src" }] },
            { seq: 3, role: "assistant", ts: at(30), toolCalls: [{ name: "apply_patch" }] },
            { seq: 4, role: "user", ts: at(45), text: "did you test?" },
            { seq: 5, role: "assistant", ts: at(50), toolCalls: [{ name: "exec_command", commandText: "bun test src/ingest/phase-spans.test.ts" }] },
            { seq: 6, role: "user", ts: at(55), text: "thanks" },
        ];

        expect(summarizeInteractionRhythm(turns)).toEqual({
            totalDurationMs: 55 * 60_000,
            userTurns: 3,
            assistantTurns: 3,
            longestHandsFreeMs: 30 * 60_000,
            corrections: 1,
        });
    });

    test("does not count idle time after the last assistant work before a separate user request", () => {
        const turns: PhaseTurn[] = [
            { seq: 1, role: "user", ts: at(0), text: "Implement one thing." },
            { seq: 2, role: "assistant", ts: at(5), text: "Implemented it." },
            { seq: 3, role: "user", ts: at(50), text: "Now implement another thing." },
            { seq: 4, role: "assistant", ts: at(55), text: "Working on the second request." },
            { seq: 5, role: "user", ts: at(58), text: "Status?" },
        ];

        expect(summarizeInteractionRhythm(turns).longestHandsFreeMs).toBe(5 * 60_000);
    });

    test("counts assistant and user turns and detects correction wording", () => {
        const turns: PhaseTurn[] = [
            { seq: 1, role: "user", ts: at(0), text: "Please implement this." },
            { seq: 2, role: "assistant", ts: at(1), text: "Working on it." },
            { seq: 3, role: "user", ts: at(2), text: "Actually, not that file." },
            { seq: 4, role: "assistant", ts: at(3), text: "Done." },
        ];

        const rhythm = summarizeInteractionRhythm(turns);

        expect(rhythm.userTurns).toBe(2);
        expect(rhythm.assistantTurns).toBe(2);
        expect(rhythm.corrections).toBe(1);
    });

    test("does not treat benign no and don't phrases as corrections", () => {
        const turns: PhaseTurn[] = [
            { seq: 1, role: "user", ts: at(0), text: "no problem" },
            { seq: 2, role: "user", ts: at(1), text: "no changes needed" },
            { seq: 3, role: "user", ts: at(2), text: "don't worry" },
            { seq: 4, role: "user", ts: at(3), text: "no, use the other file" },
            { seq: 5, role: "user", ts: at(4), text: "i meant the CLI entrypoint" },
            { seq: 6, role: "user", ts: at(5), text: "did you test?" },
        ];

        expect(summarizeInteractionRhythm(turns).corrections).toBe(3);
    });
});
