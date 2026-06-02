import { describe, expect, test } from "bun:test";
import {
    auditWeakCandidateBatch,
    mineTranscriptLabelCandidates,
    type EventWindowLike,
} from "./label-mining.ts";

const win = (input: {
    readonly user: string;
    readonly previousAssistant?: string;
    readonly sessionId?: string;
    readonly subjectId?: string;
    readonly turnId?: string;
    readonly userMessageKind?: string;
    readonly evidencePaths?: readonly string[];
}): EventWindowLike => ({
    key: `window:${input.subjectId ?? "u1"}`,
    subjectType: "event_window",
    subjectId: input.subjectId ?? "turn:u1",
    sessionId: input.sessionId ?? "session:s1",
    userTurn: {
        id: input.turnId ?? "turn:u1",
        seq: 3,
        role: "user",
        ...(input.userMessageKind ? { messageKind: input.userMessageKind } : {}),
        text: input.user,
        ts: new Date("2026-05-30T00:00:03Z"),
        evidencePath: (input.evidencePaths ?? ["transcript://session:s1/turn:u1"])[0],
    },
    previousAssistantTurn: input.previousAssistant
        ? {
            id: "turn:a1",
            seq: 1,
            role: "assistant",
            text: input.previousAssistant,
            ts: new Date("2026-05-30T00:00:01Z"),
            evidencePath: "transcript://session:s1/turn:a1",
        }
        : null,
    evidencePaths: input.evidencePaths ?? ["transcript://session:s1/turn:u1"],
});

describe("mineTranscriptLabelCandidates", () => {
    test("mines a correction caused by previous assistant action", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "no, that's wrong, not what I asked for",
                    previousAssistant: "I used pip to install the dependency.",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        const c = candidates[0]!;
        expect(c.label_family).toBe("correction");
        expect(c.source_kind).toBe("transcript_label_mining");
        expect(c.subject_type).toBe("event_window");
        expect(c.previous_assistant_turn_id).toBe("turn:a1");
        expect(c.previous_assistant_excerpt).toContain("pip");
        expect(c.evidence_paths.length).toBeGreaterThan(0);
        expect(c.weak_confidence).toBeGreaterThan(0);
        expect(c.weak_sources.length).toBeGreaterThan(0);
    });

    test("mines a direction/preference like use UV", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "use uv for python, don't use pip",
                    previousAssistant: "Running pip install ...",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("direction");
    });

    test("mines a verification demand like did you run tests", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "did you run the tests?", previousAssistant: "Done implementing." }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("verification");
    });

    test("mines an approval/rejection", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "lgtm, ship it", previousAssistant: "Here is the PR." }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.label_family).toBe("approval_or_rejection");
    });

    test("ignores wrapper/control/system text", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "<goal_context>do the thing</goal_context>" }),
                win({
                    user: "# CLAUDE.md instructions",
                    subjectId: "turn:u2",
                    turnId: "turn:u2",
                }),
                win({
                    user: "system reminder, not a real message",
                    subjectId: "turn:u3",
                    turnId: "turn:u3",
                    userMessageKind: "system_or_developer",
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(0);
    });

    test("requires evidence paths and drops candidates without them", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({
                    user: "no, that's wrong",
                    previousAssistant: "I did X.",
                    evidencePaths: [],
                }),
            ],
            limit: 500,
        });
        expect(candidates.length).toBe(0);
    });

    test("caps excerpt fields to 600 characters", () => {
        const longUser = `no, that's wrong. ${"x".repeat(2000)}`;
        const longAssistant = `I used pip. ${"y".repeat(2000)}`;
        const candidates = mineTranscriptLabelCandidates({
            windows: [win({ user: longUser, previousAssistant: longAssistant })],
            limit: 500,
        });
        expect(candidates.length).toBe(1);
        expect(candidates[0]!.excerpt.length).toBeLessThanOrEqual(600);
        expect(candidates[0]!.previous_assistant_excerpt!.length).toBeLessThanOrEqual(600);
    });

    test("respects the limit", () => {
        const windows = Array.from({ length: 10 }, (_v, i) =>
            win({
                user: "no, that's wrong",
                previousAssistant: "I did X.",
                subjectId: `turn:u${i}`,
                turnId: `turn:u${i}`,
                evidencePaths: [`transcript://session:s1/turn:u${i}`],
            }),
        );
        const candidates = mineTranscriptLabelCandidates({ windows, limit: 3 });
        expect(candidates.length).toBe(3);
    });

    test("produces stable deterministic candidate ids", () => {
        const input = {
            windows: [
                win({ user: "no, that's wrong", previousAssistant: "I did X." }),
            ],
            limit: 500,
        };
        const a = mineTranscriptLabelCandidates(input);
        const b = mineTranscriptLabelCandidates(input);
        expect(a[0]!.id).toBe(b[0]!.id);
    });
});

describe("auditWeakCandidateBatch", () => {
    test("reports ready when families are diverse and evidence present", () => {
        const candidates = mineTranscriptLabelCandidates({
            windows: [
                win({ user: "no, that's wrong", previousAssistant: "I used pip." }),
                win({
                    user: "use uv, don't use pip",
                    previousAssistant: "Running pip ...",
                    subjectId: "turn:u2",
                    turnId: "turn:u2",
                    evidencePaths: ["transcript://session:s1/turn:u2"],
                }),
                win({
                    user: "did you run the tests?",
                    previousAssistant: "Done.",
                    subjectId: "turn:u3",
                    turnId: "turn:u3",
                    evidencePaths: ["transcript://session:s1/turn:u3"],
                }),
                win({
                    user: "lgtm, ship it",
                    previousAssistant: "Here is the PR.",
                    subjectId: "turn:u4",
                    turnId: "turn:u4",
                    evidencePaths: ["transcript://session:s1/turn:u4"],
                }),
            ],
            limit: 500,
        });
        const audit = auditWeakCandidateBatch(candidates);
        expect(audit.candidate_count).toBe(4);
        expect(audit.evidence_missing_count).toBe(0);
        expect(Object.keys(audit.label_family_counts).length).toBeGreaterThanOrEqual(4);
        expect(audit.decision).toBe("candidate_batch_ready");
        expect(audit.failures.length).toBe(0);
    });

    test("fails when candidates are missing evidence", () => {
        const audit = auditWeakCandidateBatch([
            {
                id: "x",
                source_kind: "transcript_label_mining",
                subject_type: "event_window",
                subject_id: "turn:u1",
                session_id: "session:s1",
                turn_id: "turn:u1",
                label_family: "correction",
                target: "wrong_output",
                weak_label: "correction",
                weak_confidence: 0.7,
                weak_sources: ["correction"],
                evidence_paths: [],
                excerpt: "no, wrong",
            },
        ]);
        expect(audit.evidence_missing_count).toBe(1);
        expect(audit.decision).toBe("candidate_batch_failed");
        expect(audit.failures).toContain("failed_missing_evidence");
    });
});
