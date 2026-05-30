import { Effect } from "effect";
import {
    defineClassifier,
    label,
    type ClassifierResult,
    type EventWindow,
} from "../../../src/classifiers/core.ts";

const classifierKey = "direction-event";
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

    if (/\buv\b|\b(use bun|use pnpm|don'?t use npm|don'?t use pip)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "direction",
            target: "tooling_preference",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.86,
            evidence: evidenceFor(window, "tooling_preference"),
            signals: ["direction:tooling_preference"],
        })];
    }

    if (/\b(docker compose|docker-compose|compose up|dev database|dev db|predictable dev environment|use nix)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "direction",
            target: "dev_environment",
            polarity: "explore",
            durability: "repo_preference",
            confidence: 0.8,
            evidence: evidenceFor(window, "dev_environment"),
            signals: ["direction:dev_environment"],
        })];
    }

    if (/\b(ask fabijons|ask .*review|review this plan|roast it)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "direction",
            target: "review_request",
            polarity: "explore",
            durability: "one_off",
            confidence: 0.84,
            evidence: evidenceFor(window, "review_request"),
            signals: ["direction:review_request"],
        })];
    }

    if (/\b(don'?t want just html|not just html|want to see the results|show.*results)\b/i.test(lower)) {
        return [label(window, {
            classifierKey,
            classifierVersion,
            label: "direction",
            target: "output_expectation",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.82,
            evidence: evidenceFor(window, "output_expectation"),
            signals: ["direction:output_expectation"],
        })];
    }

    return [];
}

export const directionEventClassifier = defineClassifier({
    key: classifierKey,
    version: classifierVersion,
    kind: "heuristic",
    description: "Identifies user instructions that should steer agent workflow or output choices.",
    input: "event_window",
    labels: ["direction"],
    targets: ["tooling_preference", "review_request", "dev_environment", "output_expectation"],
    classify: (window) => Effect.succeed(classify(window)),
});
