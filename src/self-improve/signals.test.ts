import { describe, expect, test } from "bun:test";
import {
    deriveRepeatedCommandFailureSignals,
    deriveVerificationGapSignals,
    type SignalInput,
} from "./signals.ts";

const base: SignalInput = {
    sessions: [{ id: "session:one", project: "agentctl", startedAt: "2026-05-10T00:00:00.000Z" }],
    toolCalls: [],
    planSnapshots: [],
};

describe("self-improve signals", () => {
    test("deriveRepeatedCommandFailureSignals groups repeated failing commands", () => {
        const signals = deriveRepeatedCommandFailureSignals({
            ...base,
            toolCalls: [
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:00:00.000Z" },
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:01:00.000Z" },
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:02:00.000Z" },
            ],
        }, 3);
        expect(signals).toHaveLength(1);
        expect(signals[0].kind).toBe("repeated_command_failure");
        expect(signals[0].metrics.failureCount).toBe(3);
    });

    test("deriveVerificationGapSignals flags sessions with edits and no verification command", () => {
        const signals = deriveVerificationGapSignals({
            ...base,
            toolCalls: [
                { sessionId: "session:one", commandNorm: "apply_patch", hasError: false, ts: "2026-05-10T00:00:00.000Z" },
            ],
        });
        expect(signals[0].kind).toBe("missing_verification");
    });
});
