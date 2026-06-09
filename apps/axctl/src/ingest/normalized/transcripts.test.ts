import { describe, expect, it } from "bun:test";
import {
    buildNormalizedSyntheticSkillInvocationStatements,
    buildNormalizedTranscriptStatements,
    buildNormalizedTurnStatements,
} from "./transcripts.ts";
import { toolCallRecordKey, turnRecordKey } from "../record-keys.ts";

describe("normalized transcript persistence", () => {
    it("writes escaped turn records with optional agent event links", () => {
        const sql = buildNormalizedTurnStatements([
            {
                sessionId: "session`a",
                seq: 2,
                ts: "2026-05-29T00:00:00.000Z",
                role: "user",
                messageKind: "task",
                intentKind: "organic_task",
                text: "hello",
                textExcerpt: "hello",
                hasToolUse: false,
                hasError: false,
                agentEvent: {
                    provider: "opencode",
                    providerSessionId: "session`a",
                    providerEventId: "msg`2",
                    seq: 2,
                },
            },
        ]).join("\n");

        expect(sql).toContain("UPSERT turn:`session_a__");
        expect(sql).toContain("session: session:`session\\`a`");
        expect(sql).toContain("agent_event: agent_event:`opencode__");
        expect(sql).toContain("role: \"user\"");
    });

    it("builds provider graph, session graph, and turns from one batch", () => {
        const sql = buildNormalizedTranscriptStatements({
            providers: [{
                name: "cursor",
                displayName: "Cursor",
                capabilities: { sqlite: true },
            }],
            sessions: [{
                id: "cursor-session-1",
                provider: "cursor",
                title: "Composer",
                sourcePath: "/tmp/state.vscdb",
                startedAt: "2026-05-29T00:00:00.000Z",
                endedAt: "2026-05-29T00:00:01.000Z",
            }],
            events: [{
                provider: "cursor",
                providerSessionId: "cursor-session-1",
                providerEventId: "event-1",
                seq: 1,
                ts: "2026-05-29T00:00:00.000Z",
                type: "message",
                role: "user",
            }],
            turns: [],
        }).join("\n");

        expect(sql).toContain("UPSERT agent_provider:`cursor`");
        expect(sql).toContain("UPSERT agent_session:`cursor__");
        expect(sql).toContain("UPSERT agent_event:`cursor__");
    });

    it("builds synthetic skill invocation statements with provider-owned placeholders", () => {
        const sql = buildNormalizedSyntheticSkillInvocationStatements([{
            sessionId: "session`a",
            seq: 2,
            ts: "2026-05-29T00:00:00.000Z",
            skillName: "opencode:grep",
            args: { pattern: "TODO" },
            skillScope: "opencode-tool",
            skillContentHash: "opencode",
        }]).join("\n");

        expect(sql).toContain("UPSERT skill:`v2__opencode_grep__");
        expect(sql).toContain("scope: \"opencode-tool\"");
        expect(sql).toContain("dir_path: \"(synthetic)\"");
        expect(sql).toContain("content_hash: \"opencode\"");
        expect(sql).toContain("RELATE turn:`session_a__");
        expect(sql).toContain("->invoked:");
        expect(sql).toContain("session = session:`session\\`a`");
        expect(sql).toContain("turn_has_error = false");
        expect(sql).toContain("turn_index = 2");
        expect(sql).toContain('args = "{\\"pattern\\":\\"TODO\\"}"');
    });

    it("builds tool calls, local file evidence, and tool-skill relations from one normalized batch", () => {
        const toolCallKey = toolCallRecordKey({
            sessionId: "session-a",
            seq: 1,
            callId: "call-1",
        });
        const turnKey = turnRecordKey("session-a", 1);
        const sql = buildNormalizedTranscriptStatements({
            sessions: [{
                id: "session-a",
                provider: "opencode",
                cwd: "/repo",
                startedAt: "2026-05-29T00:00:00.000Z",
            }],
            turns: [{
                sessionId: "session-a",
                seq: 1,
                ts: "2026-05-29T00:00:00.000Z",
                role: "assistant",
                messageKind: "tool_call",
                intentKind: "tool_result",
                text: null,
                textExcerpt: null,
                hasToolUse: true,
                hasError: false,
            }],
            toolCalls: [{
                sessionId: "session-a",
                turnKey,
                provider: "opencode",
                toolName: "grep",
                toolKind: "cli",
                seq: 1,
                callId: "call-1",
                ts: "2026-05-29T00:00:00.000Z",
                cwd: "/repo",
                inputJson: { path: "src/ingest/opencode.ts" },
                outputExcerpt: "src/ingest/opencode.ts:1:import",
                hasError: false,
            }],
            toolFileEvidence: [{
                kind: "searched_file",
                sessionId: "session-a",
                toolCallKey,
                toolName: "grep",
                ts: "2026-05-29T00:00:00.000Z",
                path: "/repo/src/ingest/opencode.ts",
                pathSeen: "src/ingest/opencode.ts",
                evidence: "tool_name:grep",
                excerpt: "src/ingest/opencode.ts:1:import",
            }],
            toolCallSkillRelations: [{
                toolCallKey,
                skillName: "opencode:grep",
                ts: "2026-05-29T00:00:00.000Z",
                reason: "provider_tool_call",
            }],
        }).join("\n");

        expect(sql).toContain("UPSERT tool:");
        expect(sql).toContain("UPSERT tool_call:");
        expect(sql).toContain(`tool_call:\`${toolCallKey}\``);
        expect(sql).toContain("UPSERT file:");
        expect(sql).toContain("->searched_file:");
        expect(sql).toContain("->concerns:");
        expect(sql).toContain("kind = \"invoked_skill\"");
    });
});
