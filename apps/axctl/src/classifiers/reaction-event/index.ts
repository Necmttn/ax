import { definePatternClassifier, type EventWindow } from "../core.ts";

const recentToolFailureText = (window: EventWindow): string | null =>
    window.recentToolFailures.map((failure) => failure.text ?? "").find((text) => text.trim().length > 0) ?? null;

export const reactionEventClassifier = definePatternClassifier({
    key: "reaction-event",
    version: "0.1.0",
    description: "Classifies user reactions to the previous assistant output.",
    skipControlText: true,
    evidence: (window, matched) => ({
        user: window.userTurn.text,
        previousAssistant: window.previousAssistantTurn?.text ?? null,
        recentToolFailure: recentToolFailureText(window),
        matched,
    }),
    patterns: [
        {
            test: /\buv\b|\buse uv\b|\bcan you use uv\b|\buse bun\b|\bdon'?t use npm\b|\bdon'?t use pip\b/i,
            label: "direction",
            target: "environment_setup",
            matched: "tooling_direction",
            polarity: "revise",
            durability: "repo_preference",
            confidence: (window) => (recentToolFailureText(window) ? 0.9 : 0.82),
            signals: (window, lower) =>
                [
                    ...(recentToolFailureText(window) ? ["context:recent_tool_failure"] : []),
                    /\buv\b/i.test(lower) ? "tooling:uv" : null,
                    /\bbun\b/i.test(lower) ? "tooling:bun" : null,
                    "target:environment_setup",
                ].filter((value): value is string => value !== null),
        },
        {
            test: /\b(not just html|dont want just html|don't want just html|want to see the results|working classifier|apply to surrealml)\b/i,
            label: "correction",
            target: "prototype_completeness",
            matched: "prototype_not_just_html",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.88,
            signals: ["prototype:not_just_html", "target:prototype_completeness"],
        },
        {
            test: /\b(test|verify|show output|prove|did you run)\b/i,
            label: "direction",
            target: "verification",
            matched: "verification_direction",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.78,
            signals: ["target:verification"],
        },
        {
            test: /^(no|nope|nah)\b|\b(wrong|not what i asked|not that|instead|rather)\b/i,
            label: "correction",
            target: "wrong_output",
            matched: "wrong_output",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.76,
            signals: ["target:wrong_output"],
        },
        {
            test: /^(yes|yeah|yep|exactly|correct|works|ship)\b/i,
            label: "approval",
            target: "unknown",
            matched: "approval",
            polarity: "accept",
            durability: "one_off",
            confidence: 0.82,
            signals: ["feedback:approval"],
        },
    ],
});
