import { describe, expect, test } from "bun:test";
import { renderClassifierExplainMarkdown } from "./classifiers-explain-format.ts";

describe("renderClassifierExplainMarkdown", () => {
    test("renders classifier evidence compactly", () => {
        const output = renderClassifierExplainMarkdown({
            turn: {
                id: "turn:u1",
                session: "session:s1",
                seq: 3,
                role: "user",
                text: "did you run tests?",
                ts: "2026-05-30T00:00:00Z",
            },
            results: [{
                id: "classifier_result:r1",
                classifier_key: "verification-event",
                classifier_version: "0.1.0",
                label: "verification_request",
                target: "test_required",
                polarity: "revise",
                durability: "session_preference",
                confidence: 0.86,
                method: "heuristic",
                signals: JSON.stringify(["verification:test_required"]),
                evidence_json: JSON.stringify({ user: "did you run tests?", matched: "test_required" }),
            }],
        });

        expect(output).toContain("# classifier explain turn:u1");
        expect(output).toContain("verification-event@0.1.0");
        expect(output).toContain("target    test_required");
        expect(output).toContain("signals   verification:test_required");
        expect(output).toContain("did you run tests?");
    });
});
