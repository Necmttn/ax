import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { __testExtractClaudeJsonlLines, writeTokenUsageForSubagents } from "./transcripts.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("token usage writers", { requireFts: true });

describe("token usage writer on real DuckDB", () => {
    dtest("persists cache-inclusive Claude totals and turn usage", async () => {
        const extracted = __testExtractClaudeJsonlLines([
            JSON.stringify({
                type: "user", uuid: "u1", timestamp: "2026-06-01T10:00:00.000Z",
                sessionId: "cl-tok", cwd: "/tmp", message: { role: "user", content: "do a thing" },
            }),
            JSON.stringify({
                type: "assistant", uuid: "a1", timestamp: "2026-06-01T10:00:01.000Z",
                sessionId: "cl-tok", message: {
                    role: "assistant", model: "claude-opus-4-8", content: "ok",
                    usage: { input_tokens: 100, output_tokens: 50,
                        cache_creation_input_tokens: 200, cache_read_input_tokens: 1000 },
                },
            }),
        ], "-tmp", "cl-tok");
        expect(extracted?.tokenUsage).not.toBeNull();

        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-token-usage-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeTokenUsageForSubagents(write, extracted!);
                row = (yield* write.rows(Schema.Struct({
                    source: Schema.String, model: Schema.String, prompt_tokens: Schema.BigInt,
                    completion_tokens: Schema.BigInt, cache_creation_input_tokens: Schema.BigInt,
                    cache_read_input_tokens: Schema.BigInt, estimated_tokens: Schema.BigInt,
                }), `SELECT source, model, prompt_tokens, completion_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens
                    FROM session_token_usage`))[0];
            }),
        ));
        expect(row).toEqual({
            source: "claude-subagent", model: "claude-opus-4-8",
            prompt_tokens: 1300n, completion_tokens: 50n,
            cache_creation_input_tokens: 200n, cache_read_input_tokens: 1000n,
            estimated_tokens: 1350n,
        });
    });
});
