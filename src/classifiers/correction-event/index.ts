import { Effect } from "effect";
import { defineClassifier, label, type ClassifierResult, type EventWindow } from "../core.ts";

const classifierKey = "correction-event";
const classifierVersion = "0.1.0";

const evidenceFor = (window: EventWindow, matched: string): Record<string, unknown> => ({
    user: window.userTurn.text,
    previousAssistant: window.previousAssistantTurn?.text ?? null,
    matched,
});

function classify(window: EventWindow): readonly ClassifierResult[] {
    const text = window.userTurn.text.trim();
    if (text.length === 0) return [];
    const lower = text.toLowerCase();

    if (/\b(don'?t want just html|not just html|want to see the results|actually useful things|apply to surrealml)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "correction",
            target: "wrong_artifact",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.86,
            evidence: evidenceFor(window, "wrong_artifact"),
            signals: ["correction:wrong_artifact"],
        })];
    }

    if (/\b(previous context|not only the user message|what agent was done|caused this message|missed the context)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "correction",
            target: "missing_context",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.88,
            evidence: evidenceFor(window, "missing_context"),
            signals: ["correction:missing_context"],
        })];
    }

    if (/\b(direction thing|not a correction|misclassified|classification.*wrong|wrong classifier)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "correction",
            target: "misclassified_intent",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.82,
            evidence: evidenceFor(window, "misclassified_intent"),
            signals: ["correction:misclassified_intent"],
        })];
    }

    if (/^(no|nope|nah)\b|\b(wrong|not what i asked|not that)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "correction",
            target: "wrong_output",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.74,
            evidence: evidenceFor(window, "wrong_output"),
            signals: ["correction:wrong_output"],
        })];
    }

    return [];
}

export const correctionEventClassifier = defineClassifier({
    key: classifierKey,
    version: classifierVersion,
    kind: "heuristic",
    description: "Identifies user corrections and what was wrong with the agent response or interpretation.",
    input: "event_window",
    labels: ["correction"],
    targets: ["wrong_artifact", "missing_context", "misclassified_intent", "wrong_output"],
    classify: (window) => Effect.succeed(classify(window)),
});
