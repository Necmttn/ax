import { definePatternClassifier } from "../../../apps/axctl/src/classifiers/core.ts";

export const verificationEventClassifier = definePatternClassifier({
    key: "verification-event",
    version: "0.1.0",
    description: "Identifies user requests for proof, test output, and regression protection.",
    skipControlText: true,
    patterns: [
        {
            test: /\b(did you run|run the tests|test it|verify|typecheck|smoke test)\b/i,
            label: "verification_request",
            target: "test_required",
            matched: "test_required",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.86,
            signals: ["verification:test_required"],
        },
        {
            test: /\b(show output|show me the output|want to see the results|see results|actual results)\b/i,
            label: "verification_request",
            target: "output_required",
            matched: "output_required",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.84,
            signals: ["verification:output_required"],
        },
        {
            test: /\b(don'?t fuck up|don'?t regress|regression|evolve mechanism|test mechanism|trained models)\b/i,
            label: "verification_request",
            target: "regression_guard",
            matched: "regression_guard",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.82,
            signals: ["verification:regression_guard"],
        },
    ],
});
