import { Effect } from "effect";
import {
    defineClassifier,
    label,
    type ClassifierResult,
    type EventWindow,
} from "../../../apps/axctl/src/classifiers/core.ts";
import { isControlOrContextText } from "../../../apps/axctl/src/classifiers/control-text.ts";

const classifierKey = "verification-event";
const classifierVersion = "0.1.0";

const evidenceFor = (window: EventWindow, matched: string): Record<string, unknown> => ({
    user: window.userTurn.text,
    previousAssistant: window.previousAssistantTurn?.text ?? null,
    matched,
});

function classify(window: EventWindow): readonly ClassifierResult[] {
    const text = window.userTurn.text.trim();
    if (text.length === 0 || isControlOrContextText(text)) return [];
    const lower = text.toLowerCase();

    if (/\b(did you run|run the tests|test it|verify|typecheck|smoke test)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "verification_request",
            target: "test_required",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.86,
            evidence: evidenceFor(window, "test_required"),
            signals: ["verification:test_required"],
        })];
    }

    if (/\b(show output|show me the output|want to see the results|see results|actual results)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "verification_request",
            target: "output_required",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.84,
            evidence: evidenceFor(window, "output_required"),
            signals: ["verification:output_required"],
        })];
    }

    if (/\b(don'?t fuck up|don'?t regress|regression|evolve mechanism|test mechanism|trained models)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "verification_request",
            target: "regression_guard",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.82,
            evidence: evidenceFor(window, "regression_guard"),
            signals: ["verification:regression_guard"],
        })];
    }

    return [];
}

export const verificationEventClassifier = defineClassifier({
    key: classifierKey,
    version: classifierVersion,
    kind: "heuristic",
    description: "Identifies user requests for proof, test output, and regression protection.",
    input: "event_window",
    labels: ["verification_request"],
    targets: ["test_required", "output_required", "regression_guard"],
    classify: (window) => Effect.succeed(classify(window)),
});
