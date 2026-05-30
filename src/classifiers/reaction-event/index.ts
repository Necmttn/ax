import { Effect } from "effect";
import { defineClassifier, label, type EventWindow, type ClassifierResult } from "../core.ts";

const classifierKey = "reaction-event";
const classifierVersion = "0.1.0";

const recentToolFailureText = (window: EventWindow): string | null =>
    window.recentToolFailures.map((failure) => failure.text ?? "").find((text) => text.trim().length > 0) ?? null;

const isWrapperOrContextText = (text: string): boolean =>
    text.startsWith("<goal_context>") ||
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("# CLAUDE.md") ||
    text.includes("<INSTRUCTIONS>") ||
    text.includes("<environment_context>") ||
    text.startsWith("<task>") ||
    text.startsWith("<task-notification>");

const evidenceFor = (
    window: EventWindow,
    matched: string,
): Record<string, unknown> => ({
    user: window.userTurn.text,
    previousAssistant: window.previousAssistantTurn?.text ?? null,
    recentToolFailure: recentToolFailureText(window),
    matched,
});

function classify(window: EventWindow): readonly ClassifierResult[] {
    const text = window.userTurn.text.trim();
    if (text.length === 0 || isWrapperOrContextText(text)) return [];
    const lower = text.toLowerCase();
    const toolFailure = recentToolFailureText(window);
    const baseSignals = toolFailure ? ["context:recent_tool_failure"] : [];

    if (/\buv\b|\buse uv\b|\bcan you use uv\b|\buse bun\b|\bdon'?t use npm\b|\bdon'?t use pip\b/i.test(lower)) {
        const signals = [
            ...baseSignals,
            /\buv\b/i.test(lower) ? "tooling:uv" : null,
            /\bbun\b/i.test(lower) ? "tooling:bun" : null,
            "target:environment_setup",
        ].filter((value): value is string => value !== null);
        return [
            label(window, {
                classifierKey,
                classifierVersion,
                label: "direction",
                target: "environment_setup",
                polarity: "revise",
                durability: "repo_preference",
                confidence: toolFailure ? 0.9 : 0.82,
                evidence: evidenceFor(window, "tooling_direction"),
                signals,
            }),
        ];
    }

    if (/\b(not just html|dont want just html|don't want just html|want to see the results|working classifier|apply to surrealml)\b/i.test(lower)) {
        return [
            label(window, {
                classifierKey,
                classifierVersion,
                label: "correction",
                target: "prototype_completeness",
                polarity: "revise",
                durability: "repo_preference",
                confidence: 0.88,
                evidence: evidenceFor(window, "prototype_not_just_html"),
                signals: ["prototype:not_just_html", "target:prototype_completeness"],
            }),
        ];
    }

    if (/\b(test|verify|show output|prove|did you run)\b/i.test(lower)) {
        return [
            label(window, {
                classifierKey,
                classifierVersion,
                label: "direction",
                target: "verification",
                polarity: "revise",
                durability: "session_preference",
                confidence: 0.78,
                evidence: evidenceFor(window, "verification_direction"),
                signals: ["target:verification"],
            }),
        ];
    }

    if (/^(no|nope|nah)\b|\b(wrong|not what i asked|not that|instead|rather)\b/i.test(lower)) {
        return [
            label(window, {
                classifierKey,
                classifierVersion,
                label: "correction",
                target: "wrong_output",
                polarity: "revise",
                durability: "session_preference",
                confidence: 0.76,
                evidence: evidenceFor(window, "wrong_output"),
                signals: ["target:wrong_output"],
            }),
        ];
    }

    if (/^(yes|yeah|yep|exactly|correct|works|ship)\b/i.test(lower)) {
        return [
            label(window, {
                classifierKey,
                classifierVersion,
                label: "approval",
                target: "unknown",
                polarity: "accept",
                durability: "one_off",
                confidence: 0.82,
                evidence: evidenceFor(window, "approval"),
                signals: ["feedback:approval"],
            }),
        ];
    }

    return [];
}

export const reactionEventClassifier = defineClassifier({
    key: classifierKey,
    version: classifierVersion,
    kind: "heuristic",
    description: "Classifies user reactions to the previous assistant output.",
    input: "event_window",
    labels: ["approval", "correction", "direction"],
    targets: ["environment_setup", "prototype_completeness", "verification", "wrong_output", "unknown"],
    classify: (window) => Effect.succeed(classify(window)),
});
