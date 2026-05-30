import { describe, expect, test } from "bun:test";
import {
    normalizeDelegationToolCall,
    providerDelegationSignalAvailability,
} from "./delegation.ts";

describe("provider delegation signal contract", () => {
    test("normalizes Codex spawn_agent output into a shared spawned source", () => {
        const spawn = normalizeDelegationToolCall({
            provider: "codex",
            toolCallId: "tool_call:⟨spawn-call⟩",
            parentSessionId: "session:⟨parent-session⟩",
            ts: "2026-05-09T10:00:00.000Z",
            toolName: "spawn_agent",
            outputExcerpt: JSON.stringify({
                agent_id: "child-session",
                nickname: "Babbage",
            }),
        });

        expect(spawn).toEqual({
            provider: "codex",
            toolCallId: "tool_call:⟨spawn-call⟩",
            parentSessionId: "session:⟨parent-session⟩",
            ts: "2026-05-09T10:00:00.000Z",
            childSessionId: "child-session",
            nickname: "Babbage",
            toolName: "spawn_agent",
        });
    });

    test("keeps unresolved delegation sources explicit", () => {
        const spawn = normalizeDelegationToolCall({
            provider: "claude",
            toolCallId: "tool_call:⟨task-call⟩",
            parentSessionId: "session:⟨parent-session⟩",
            ts: "2026-05-09T10:00:00.000Z",
            toolName: "Task",
            outputExcerpt: "not json",
        });

        expect(spawn).toMatchObject({
            provider: "claude",
            childSessionId: null,
            nickname: null,
            toolName: "Task",
        });
    });

    test("marks provider availability from observed raw signals", () => {
        expect(providerDelegationSignalAvailability.claude).toMatchObject({
            status: "available",
            sharedRecords: ["spawned"],
        });
        expect(providerDelegationSignalAvailability.codex).toMatchObject({
            status: "available",
            rawSignals: ["spawn_agent tool output"],
        });

        for (const provider of ["pi", "opencode", "cursor"] as const) {
            expect(providerDelegationSignalAvailability[provider].status).toBe("unavailable");
            expect(providerDelegationSignalAvailability[provider].rawSignals).toEqual([]);
        }
    });
});
