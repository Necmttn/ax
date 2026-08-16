import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import {
    agentEventRecordKey,
    agentProviderRecordKey,
    agentSessionRecordKey,
    writeAgentEvents,
    writeAgentProviders,
} from "./provider-events.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("provider event writers", { requireFts: true });

describe("provider event keys", () => {
    dtest("record keys are stable and provider scoped", () => {
        expect(agentProviderRecordKey("claude")).toBe("claude");
        expect(agentSessionRecordKey("codex", "session-1/unsafe"))
            .toMatch(/^codex__session_1_unsafe__[0-9a-f]{16}$/);
        expect(agentEventRecordKey({
            provider: "codex", providerSessionId: "session-1/unsafe",
            providerEventId: "evt-1/unsafe", seq: 7,
        })).toMatch(/__evt_1_unsafe__[0-9a-f]{16}$/);
        expect(agentEventRecordKey({
            provider: "codex", providerSessionId: "session-1/unsafe", seq: 7,
        })).toMatch(/__seq_000007$/);
    });
});

describe("provider event writers on real DuckDB", () => {
    dtest("writes typed provider, session, event, and parent edge rows", async () => {
        let counts: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-provider-events-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeAgentProviders(write, [{
                    name: "codex", displayName: "Codex CLI", version: "0.1.0",
                    capabilities: { transcripts: true, tools: ["exec_command"] },
                }]);
                yield* writeAgentEvents(write, {
                    sessions: [{
                        provider: "codex", providerSessionId: "session-1", axSessionId: "session-1",
                        raw: { source: "fixture" }, startedAt: "2026-05-29T01:00:00.000Z",
                    }],
                    events: [
                        { provider: "codex", providerSessionId: "session-1", providerEventId: "parent",
                            seq: 1, ts: "2026-05-29T01:00:01.000Z", type: "message" },
                        { provider: "codex", providerSessionId: "session-1", providerEventId: "child",
                            parentProviderEventId: "parent", parentProviderEventIds: ["parent"],
                            seq: 2, ts: "2026-05-29T01:00:02.000Z", type: "message" },
                    ],
                });
                counts = (yield* write.rows(Schema.Struct({
                    providers: Schema.BigInt, sessions: Schema.BigInt,
                    events: Schema.BigInt, edges: Schema.BigInt,
                }), `SELECT
                    (SELECT count(*) FROM agent_provider) AS providers,
                    (SELECT count(*) FROM agent_session) AS sessions,
                    (SELECT count(*) FROM agent_event) AS events,
                    (SELECT count(*) FROM agent_event_child) AS edges`))[0];
            }),
        ));
        expect(counts).toEqual({ providers: 1n, sessions: 1n, events: 2n, edges: 1n });
    });

    dtest("re-ingest replaces events, while a streaming batch appends", async () => {
        let ids: string[] = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-provider-replace-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const session = { provider: "codex" as const, providerSessionId: "session-1", axSessionId: "session-1" };
                const event = (id: string, seq: number) => ({
                    provider: "codex" as const, providerSessionId: "session-1", providerEventId: id,
                    seq, ts: new Date(1_700_000_000_000 + seq), type: "message",
                });
                yield* writeAgentEvents(write, { sessions: [session], events: [event("old", 1)] });
                yield* writeAgentEvents(write, { sessions: [session], events: [event("new", 1)] });
                yield* writeAgentEvents(write, { sessions: [session], events: [event("later", 2)] }, { clearExisting: false });
                ids = (yield* write.rows(
                    Schema.Struct({ provider_event_id: Schema.String }),
                    "SELECT provider_event_id FROM agent_event ORDER BY seq",
                )).map((row) => row.provider_event_id);
            }),
        ));
        expect(ids).toEqual(["new", "later"]);
    });
});
