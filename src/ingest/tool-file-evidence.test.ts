import { describe, expect, test } from "bun:test";
import {
    classifyToolFileEvidence,
    evidenceReason,
    extractToolFileEvidence,
} from "./tool-file-evidence.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";

describe("tool file evidence classification", () => {
    test("classifies file read tools and shell readers", () => {
        expect(classifyToolFileEvidence({ name: "Read" })).toEqual(["read_file"]);
        expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: "sed" })).toEqual(["read_file"]);
        expect(evidenceReason({ name: "exec_command", commandNorm: "sed" }, "read_file")).toBe("command_norm:sed");
    });

    test("classifies search tools and shell search commands", () => {
        expect(classifyToolFileEvidence({ name: "Grep" })).toEqual(["searched_file"]);
        expect(classifyToolFileEvidence({ name: "Bash", commandNorm: "rg" })).toEqual(["searched_file"]);
        expect(evidenceReason({ name: "Bash", commandNorm: "rg" }, "searched_file")).toBe("command_norm:rg");
    });

    test("ignores unrelated commands", () => {
        expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: "git status" })).toEqual([]);
    });

    test("extracts edit/read/search paths from structured tool calls", () => {
        const readKey = toolCallRecordKey({
            sessionId: "session-1",
            seq: 1,
            callId: "call-read",
        });
        const grepKey = toolCallRecordKey({
            sessionId: "session-1",
            seq: 2,
            callId: "call-grep",
        });
        const editKey = toolCallRecordKey({
            sessionId: "session-1",
            seq: 3,
            callId: "call-edit",
        });

        expect(extractToolFileEvidence([
            {
                provider: "pi",
                toolName: "Read",
                toolKind: "builtin",
                sessionId: "session-1",
                seq: 1,
                turnKey: turnRecordKey("session-1", 1),
                callId: "call-read",
                ts: "2026-05-29T06:00:00.000Z",
                cwd: "/repo",
                inputJson: { file_path: "src/read.ts" },
                hasError: false,
            },
            {
                provider: "pi",
                toolName: "Grep",
                toolKind: "builtin",
                sessionId: "session-1",
                seq: 2,
                turnKey: turnRecordKey("session-1", 2),
                callId: "call-grep",
                ts: "2026-05-29T06:00:01.000Z",
                cwd: "/repo",
                inputJson: { pattern: "needle", path: "src" },
                hasError: false,
            },
            {
                provider: "codex",
                toolName: "apply_patch",
                toolKind: "builtin",
                sessionId: "session-1",
                seq: 3,
                turnKey: turnRecordKey("session-1", 3),
                callId: "call-edit",
                ts: "2026-05-29T06:00:02.000Z",
                cwd: "/repo",
                inputJson: {
                    patch: "*** Begin Patch\n*** Update File: src/edit.ts\n@@\n-old\n+new\n*** End Patch",
                },
                hasError: false,
            },
        ]).map((item) => ({
            kind: item.kind,
            toolCallKey: item.toolCallKey,
            path: item.path,
            pathSeen: item.pathSeen,
            evidence: item.evidence,
        }))).toEqual([
            {
                kind: "read_file",
                toolCallKey: readKey,
                path: "/repo/src/read.ts",
                pathSeen: "src/read.ts",
                evidence: "tool_name:Read",
            },
            {
                kind: "searched_file",
                toolCallKey: grepKey,
                path: "/repo/src",
                pathSeen: "src",
                evidence: "tool_name:Grep",
            },
            {
                kind: "edited",
                toolCallKey: editKey,
                path: "/repo/src/edit.ts",
                pathSeen: "src/edit.ts",
                evidence: "tool_name:apply_patch",
            },
        ]);
    });
});
