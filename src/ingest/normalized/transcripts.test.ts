import { describe, expect, it } from "bun:test";
import {
    buildNormalizedTranscriptStatements,
    buildNormalizedTurnStatements,
} from "./transcripts.ts";

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
});
