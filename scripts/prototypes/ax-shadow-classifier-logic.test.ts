import { describe, expect, test } from "bun:test";
import {
    evaluateCentroid,
    featureArray,
    featuresForText,
    FEATURE_NAMES,
    macroF1,
    parseSignals,
    toEvalExamples,
    type TurnLabelRow,
} from "./ax-shadow-classifier-logic.ts";

const row = (overrides: Partial<TurnLabelRow>): TurnLabelRow => ({
    row_type: "turn_label_row",
    turn_id: "turn:a",
    session_id: "session:a",
    seq: 1,
    source: "codex",
    role: "user",
    message_kind: "task",
    intent_kind: null,
    text_excerpt: "",
    text: "",
    previous_assistant_turn_id: null,
    previous_assistant_text: null,
    act: "correction",
    sentiment: "negative",
    polarity: "revise",
    confidence: 0.9,
    signals: [],
    semantic_kind: null,
    semantic_label: null,
    canonical_text: null,
    ts: null,
    session_started_at: null,
    cwd: null,
    ...overrides,
});

describe("shadow classifier logic", () => {
    test("parses JSON-encoded turn signals defensively", () => {
        expect(parseSignals('["intent:correction","signal:wrong_target"]')).toEqual([
            "intent:correction",
            "signal:wrong_target",
        ]);
        expect(parseSignals("not-json")).toEqual([]);
        expect(parseSignals(null)).toEqual([]);
    });

    test("extracts stable numeric features for SurrealML inputs", () => {
        const features = featuresForText("No, keep this as a prototype instead.", 0.82);
        expect(Object.keys(features)).toEqual([...FEATURE_NAMES]);
        expect(featureArray(features)).toHaveLength(FEATURE_NAMES.length);
        expect(features.has_no).toBe(1);
        expect(features.has_keep).toBe(1);
        expect(features.has_instead).toBe(1);
        expect(features.confidence).toBe(0.82);
    });

    test("builds reaction and polarity examples from user rows", () => {
        const rows = [
            row({ session_id: "s1", polarity: "accept", text: "yes ship it" }),
            row({ session_id: "s1", polarity: "none", text: "can you inspect this?" }),
            row({ session_id: "s2", polarity: "reject", text: "no wrong file" }),
        ];
        expect(toEvalExamples(rows, "reaction").map((example) => example.label)).toEqual([1, 0, 1]);
        expect(toEvalExamples(rows, "polarity").map((example) => example.label)).toEqual([0, 1]);
    });

    test("computes macro F1 and evaluates a session-held-out classifier", () => {
        expect(macroF1([1, 0, 1], [1, 0, 0], [0, 1])).toBeCloseTo(0.6667, 4);
        const examples = [
            { session_id: "a", text: "yes exactly ship it", confidence: 0.9, label: 1 },
            { session_id: "b", text: "no wrong target", confidence: 0.9, label: 1 },
            { session_id: "c", text: "can you inspect logs", confidence: 0.6, label: 0 },
            { session_id: "d", text: "what is the command", confidence: 0.6, label: 0 },
            { session_id: "e", text: "keep prototype instead", confidence: 0.9, label: 1 },
            { session_id: "f", text: "show recent sessions", confidence: 0.6, label: 0 },
        ];
        const result = evaluateCentroid(examples, [0, 1]);
        expect(result.rows).toBe(6);
        expect(result.trainRows).toBeGreaterThan(0);
        expect(result.testRows).toBeGreaterThan(0);
        expect(result.classifierMacroF1).toBeGreaterThanOrEqual(0);
    });
});
