import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { writeNormalizedTranscriptBatch, type NormalizedTranscriptBatch } from "./transcripts.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("normalized transcripts", { requireFts: true });
const at = new Date("2026-05-29T00:00:00.000Z");
const emptyBatch = (): NormalizedTranscriptBatch => ({
    providers: [], sessions: [], events: [], turns: [], toolCalls: [],
    toolFileEvidence: [], agentEventParentEdges: [], syntheticSkillInvocations: [],
    toolCallSkillRelations: [], planSnapshots: [], compactions: [],
});

describe("normalized transcript persistence on real DuckDB", () => {
    dtest("writes turn links, thinking fields, and normalized JSON", async () => {
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-normalized-turn-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeNormalizedTranscriptBatch(write, {
                    ...emptyBatch(),
                    providers: [{ name: "opencode", displayName: "OpenCode" }],
                    sessions: [{ id: "session-a", provider: "opencode", startedAt: at }],
                    events: [{ provider: "opencode", providerSessionId: "session-a",
                        providerEventId: "msg-2", seq: 2, ts: at, type: "message" }],
                    turns: [{
                        sessionId: "session-a", seq: 2, ts: at, role: "assistant",
                        messageKind: "assistant", intentKind: "assistant",
                        text: "done", textExcerpt: "done", hasToolUse: false, hasError: false,
                        thinkingBlocks: 2, thinkingTokens: 50,
                        agentEvent: { provider: "opencode", providerSessionId: "session-a",
                            providerEventId: "msg-2", seq: 2 },
                    }],
                });
                row = (yield* write.rows(Schema.Struct({
                    session: Schema.String, agent_event: Schema.String,
                    thinking_blocks: Schema.BigInt, thinking_tokens: Schema.BigInt,
                }), "SELECT session, agent_event, thinking_blocks, thinking_tokens FROM turn"))[0];
            }),
        ));
        expect(row).toMatchObject({
            session: "session-a", thinking_blocks: 2n, thinking_tokens: 50n,
        });
        expect((row as { agent_event: string }).agent_event).toContain("opencode__");
    });

    dtest("preserves a catalog skill during create-if-missing invocation writes", async () => {
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-normalized-skill-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("skill", {
                    id: "catalog-id", name: "catalog-skill", scope: "user",
                    dir_path: "/skills/catalog", content_hash: "real",
                });
                yield* writeNormalizedTranscriptBatch(write, {
                    ...emptyBatch(),
                    syntheticSkillInvocations: [{
                        sessionId: "s", seq: 1, ts: at,
                        skillName: SkillName.make("catalog-skill"), skillUpsert: "if_missing",
                    }],
                }, { clearExisting: false });
                row = (yield* write.rows(Schema.Struct({
                    id: Schema.String, scope: Schema.String, content_hash: Schema.String,
                }), "SELECT id, scope, content_hash FROM skill WHERE name = 'catalog-skill'"))[0];
            }),
        ));
        expect(row).toEqual({ id: "catalog-id", scope: "user", content_hash: "real" });
    });
});
