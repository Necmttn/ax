import type { EventWindow } from "./core.ts";

export const windowFixture = (input: {
    readonly user: string;
    readonly previousAssistant?: string;
    readonly recentToolFailure?: string;
}): EventWindow => ({
    key: "window:u1",
    subjectType: "turn",
    subjectId: "turn:u1",
    sessionId: "session:s1",
    userTurn: {
        id: "turn:u1",
        key: "u1",
        seq: 3,
        role: "user",
        text: input.user,
        ts: new Date("2026-05-30T00:00:03Z"),
    },
    previousAssistantTurn: input.previousAssistant
        ? {
            id: "turn:a1",
            key: "a1",
            seq: 1,
            role: "assistant",
            text: input.previousAssistant,
            ts: new Date("2026-05-30T00:00:01Z"),
        }
        : null,
    recentToolCalls: [],
    recentToolFailures: input.recentToolFailure
        ? [{
            id: "tool:t1",
            name: "bash",
            text: input.recentToolFailure,
            ts: new Date("2026-05-30T00:00:02Z"),
        }]
        : [],
    recentFiles: [],
    existingLabels: [],
});
