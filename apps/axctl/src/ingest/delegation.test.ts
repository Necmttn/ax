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
            agentType: null,
            description: null,
        });
    });

    test("extracts agent_type + description from spawn_agent input args", () => {
        const spawn = normalizeDelegationToolCall({
            provider: "codex",
            toolCallId: "tool_call:⟨spawn-call⟩",
            parentSessionId: "session:⟨parent-session⟩",
            ts: "2026-05-09T10:00:00.000Z",
            toolName: "spawn_agent",
            outputExcerpt: JSON.stringify({ agent_id: "child-session", nickname: "Raman" }),
            inputJson: JSON.stringify({
                agent_type: "explorer",
                message: "Perform a focused architecture exploration of the ingest layer.",
                fork_context: false,
            }),
        });

        expect(spawn.agentType).toBe("explorer");
        expect(spawn.description).toBe("Perform a focused architecture exploration of the ingest layer.");
        expect(spawn.childSessionId).toBe("child-session");
    });

    test("caps long descriptions and tolerates missing args", () => {
        const long = normalizeDelegationToolCall({
            provider: "codex",
            toolCallId: "tc",
            parentSessionId: "session:⟨p⟩",
            ts: "2026-05-09T10:00:00.000Z",
            toolName: "spawn_agent",
            outputExcerpt: null,
            inputJson: JSON.stringify({ agent_type: "coder", message: "x".repeat(5000) }),
        });
        expect(long.description?.length).toBe(2000);
        expect(long.agentType).toBe("coder");

        const noArgs = normalizeDelegationToolCall({
            provider: "codex",
            toolCallId: "tc",
            parentSessionId: "session:⟨p⟩",
            ts: "2026-05-09T10:00:00.000Z",
            toolName: "spawn_agent",
            outputExcerpt: null,
        });
        expect(noArgs.agentType).toBeNull();
        expect(noArgs.description).toBeNull();
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
