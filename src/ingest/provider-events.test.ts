import { describe, expect, test } from "bun:test";
import {
    agentEventRecordKey,
    agentProviderRecordKey,
    agentSessionRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
} from "./provider-events.ts";

describe("provider event writer statement builders", () => {
    test("record keys are stable and provider-scoped", () => {
        expect(agentProviderRecordKey("claude")).toBe("claude");

        const sessionKey = agentSessionRecordKey("codex", "session-1/unsafe");
        expect(sessionKey).toBe(agentSessionRecordKey("codex", "session-1/unsafe"));
        expect(sessionKey).toMatch(/^codex__session_1_unsafe__[0-9a-f]{16}$/);

        const eventKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "session-1/unsafe",
            providerEventId: "evt-1/unsafe",
            seq: 7,
        });
        expect(eventKey).toBe(
            agentEventRecordKey({
                provider: "codex",
                providerSessionId: "session-1/unsafe",
                providerEventId: "evt-1/unsafe",
                seq: 7,
            }),
        );
        expect(eventKey).toMatch(/__evt_1_unsafe__[0-9a-f]{16}$/);

        expect(
            agentEventRecordKey({
                provider: "codex",
                providerSessionId: "session-1/unsafe",
                seq: 7,
            }),
        ).toMatch(/__seq_000007$/);
    });

    test("provider statements upsert provider rows with optional JSON text", () => {
        const sql = buildAgentProviderStatements([
            {
                name: "codex",
                displayName: "Codex CLI",
                version: "0.1.0",
                capabilities: { transcripts: true, tools: ["exec_command"] },
            },
        ]).join("\n");

        expect(sql).toContain("UPSERT agent_provider:`codex` MERGE");
        expect(sql).toContain("name: \"codex\"");
        expect(sql).toContain("display_name: \"Codex CLI\"");
        expect(sql).toContain("version: \"0.1.0\"");
        expect(sql).toContain(
            "capabilities: \"{\\\"transcripts\\\":true,\\\"tools\\\":[\\\"exec_command\\\"]}\"",
        );
        expect(sql).toContain("updated_at: time::now()");
    });

    test("event batch statements write sessions, events, and parent edges", () => {
        const statements = buildAgentEventStatements({
            sessions: [
                {
                    provider: "codex",
                    providerSessionId: "session-1/unsafe",
                    axSessionId: "ax-session-1",
                    cwd: "/tmp/ax",
                    project: "ax",
                    title: "Task 1",
                    model: "gpt-5-codex",
                    sourcePath: "/tmp/transcript.jsonl",
                    raw: { source: "fixture" },
                    labels: { imported: true },
                    metrics: { turns: 2 },
                    startedAt: "2026-05-29T01:00:00.000Z",
                    endedAt: "2026-05-29T01:02:00.000Z",
                },
            ],
            events: [
                {
                    provider: "codex",
                    providerSessionId: "session-1/unsafe",
                    providerEventId: "evt-1/unsafe",
                    seq: 1,
                    ts: "2026-05-29T01:00:01.000Z",
                    type: "message",
                    role: "user",
                    text: "Implement Task 1",
                    textExcerpt: "Implement Task 1",
                    raw: { id: "evt-1/unsafe" },
                    labels: { source: "codex" },
                    metrics: { tokens: 4 },
                },
                {
                    provider: "codex",
                    providerSessionId: "session-1/unsafe",
                    providerEventId: "evt-2/unsafe",
                    parentProviderEventIds: ["evt-1/unsafe", "missing-parent"],
                    parentKind: "reply",
                    seq: 2,
                    ts: "2026-05-29T01:00:02.000Z",
                    type: "message",
                    role: "assistant",
                    textExcerpt: "Done",
                },
            ],
        });

        const sql = statements.join("\n");
        const parentEventStatement = statements.find((statement) =>
            statement.startsWith("UPSERT agent_event:") && statement.includes("evt-1/unsafe"),
        );
        const childEventStatement = statements.find((statement) =>
            statement.startsWith("UPSERT agent_event:") && statement.includes("evt-2/unsafe"),
        );
        const sessionKey = agentSessionRecordKey("codex", "session-1/unsafe");
        const parentKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "session-1/unsafe",
            providerEventId: "evt-1/unsafe",
            seq: 1,
        });
        const childKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "session-1/unsafe",
            providerEventId: "evt-2/unsafe",
            seq: 2,
        });

        expect(sql).toContain(`UPSERT agent_session:\`${sessionKey}\` MERGE`);
        expect(sql).toContain("provider: agent_provider:`codex`");
        expect(sql).toContain("provider_session_id: \"session-1/unsafe\"");
        expect(sql).toContain("ax_session: session:`ax-session-1`");
        expect(sql).toContain("raw: \"{\\\"source\\\":\\\"fixture\\\"}\"");
        expect(sql).toContain("started_at: d\"2026-05-29T01:00:00.000Z\"");

        expect(sql).toContain(`UPSERT agent_event:\`${parentKey}\` CONTENT`);
        expect(sql).toContain(`agent_session: agent_session:\`${sessionKey}\``);
        expect(sql).toContain("provider_event_id: \"evt-1/unsafe\"");
        expect(parentEventStatement).toContain("parent_provider_event_id: NONE");
        expect(parentEventStatement).not.toContain("provider_session_id:");
        expect(childEventStatement).toContain("parent_provider_event_id: \"evt-1/unsafe\"");
        expect(childEventStatement).not.toContain("provider_session_id:");
        expect(sql).toContain("seq: 1");
        expect(sql).toContain("ts: d\"2026-05-29T01:00:01.000Z\"");
        expect(sql).toContain("text_excerpt: \"Implement Task 1\"");
        expect(sql).toContain("metrics: \"{\\\"tokens\\\":4}\"");

        expect(sql).toContain(
            `RELATE agent_event:\`${parentKey}\`->agent_event_child:\``,
        );
        expect(sql).toContain(`->agent_event:\`${childKey}\` SET`);
        expect(sql).toContain(`agent_session = agent_session:\`${sessionKey}\``);
        expect(sql).toContain("provider = agent_provider:`codex`");
        expect(sql).toContain("kind = \"reply\"");
        expect(sql).toContain("ts = d\"2026-05-29T01:00:02.000Z\"");
        expect(sql).not.toContain("missing-parent");
    });

    test("scalar parent event ids create de-duped parent edges", () => {
        const statements = buildAgentEventStatements({
            sessions: [],
            events: [
                {
                    provider: "codex",
                    providerSessionId: "session-1",
                    providerEventId: "evt-parent",
                    seq: 1,
                    ts: "2026-05-29T01:00:01.000Z",
                    type: "message",
                },
                {
                    provider: "codex",
                    providerSessionId: "session-1",
                    providerEventId: "evt-child",
                    parentProviderEventId: "evt-parent",
                    parentProviderEventIds: ["evt-parent"],
                    seq: 2,
                    ts: "2026-05-29T01:00:02.000Z",
                    type: "message",
                },
            ],
        });

        const parentKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "session-1",
            providerEventId: "evt-parent",
            seq: 1,
        });
        const childKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "session-1",
            providerEventId: "evt-child",
            seq: 2,
        });
        const edgeStatements = statements.filter((statement) =>
            statement.startsWith("RELATE agent_event:"),
        );

        expect(edgeStatements).toHaveLength(1);
        expect(edgeStatements[0]).toContain(`RELATE agent_event:\`${parentKey}\``);
        expect(edgeStatements[0]).toContain(`->agent_event:\`${childKey}\``);
    });
});
