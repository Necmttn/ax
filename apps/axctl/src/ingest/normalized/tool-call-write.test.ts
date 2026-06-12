import { describe, expect, test } from "bun:test";
import { agentEventRecordKey } from "../provider-events.ts";
import { turnRecordKey } from "../record-keys.ts";
import { applyCommandFields, makeToolCallWrite } from "./tool-call-write.ts";

describe("makeToolCallWrite", () => {
    test("builds the common write shape with callId/seq defaults for the event key", () => {
        const call = makeToolCallWrite({
            provider: "codex",
            toolName: "exec_command",
            sessionId: "s1",
            seq: 3,
            callId: "call-1",
            ts: "2026-06-13T00:00:00.000Z",
            cwd: "/repo",
            inputJson: { command: "ls" },
            rawJson: { name: "exec_command" },
        });
        expect(call.provider).toBe("codex");
        expect(call.toolKind).toBe("builtin");
        expect(call.turnKey).toBe(turnRecordKey("s1", 3));
        expect(call.agentEventKey).toBe(agentEventRecordKey({
            provider: "codex",
            providerSessionId: "s1",
            providerEventId: "call-1",
            seq: 3,
        }));
        expect(call.hasError).toBe(false);
        expect(call.cwd).toBe("/repo");
    });

    test("honors providerEventId/eventSeq overrides (opencode-style part identity)", () => {
        const call = makeToolCallWrite({
            provider: "opencode",
            toolName: "grep",
            sessionId: "s1",
            seq: 2,
            callId: "call-9",
            providerEventId: "part-row-1",
            eventSeq: 1_000_002_001,
            ts: "2026-06-13T00:00:00.000Z",
            cwd: null,
            inputJson: null,
            rawJson: {},
        });
        expect(call.agentEventKey).toBe(agentEventRecordKey({
            provider: "opencode",
            providerSessionId: "s1",
            providerEventId: "part-row-1",
            seq: 1_000_002_001,
        }));
        // seq on the write stays the TURN seq, not the synthetic event seq.
        expect(call.seq).toBe(2);
        expect(call.callId).toBe("call-9");
    });

    test("omits the cwd key entirely when undefined (cursor has no cwd)", () => {
        const call = makeToolCallWrite({
            provider: "cursor",
            toolName: "edit_file",
            sessionId: "s1",
            seq: 1,
            callId: "c1",
            ts: "2026-06-13T00:00:00.000Z",
            inputJson: null,
            rawJson: {},
        });
        expect("cwd" in call).toBe(false);
    });
});

describe("applyCommandFields", () => {
    test("fills the command triple from command or cmd", () => {
        const call = makeToolCallWrite({
            provider: "pi",
            toolName: "exec_command",
            sessionId: "s1",
            seq: 1,
            callId: "c1",
            ts: "2026-06-13T00:00:00.000Z",
            cwd: null,
            inputJson: { command: "git status" },
            rawJson: {},
        });
        applyCommandFields(call, { command: "git status" });
        expect(call.commandText).toBe("git status");
        expect(call.commandToolName).toBe("git");
        expect(call.commandNorm).toBeDefined();
    });

    test("no-ops for non-record input or a missing command", () => {
        const call = makeToolCallWrite({
            provider: "pi",
            toolName: "exec_command",
            sessionId: "s1",
            seq: 1,
            callId: "c1",
            ts: "2026-06-13T00:00:00.000Z",
            cwd: null,
            inputJson: "raw string",
            rawJson: {},
        });
        applyCommandFields(call, "raw string");
        applyCommandFields(call, { other: 1 });
        expect(call.commandText).toBeUndefined();
        expect(call.commandToolName).toBeUndefined();
        expect(call.commandNorm).toBeUndefined();
    });
});
