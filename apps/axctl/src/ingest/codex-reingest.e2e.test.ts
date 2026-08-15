import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { __testExtractCodexJsonlLines, toCodexNormalizedBatch } from "./codex.ts";
import { writeNormalizedTranscriptBatch } from "./normalized/transcripts.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("codex re-ingest", { requireFts: true });

const lines = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-05-09T10:00:00.000Z",
        payload: { id: "codex-reingest", cwd: "/tmp/e2e", cli_version: "0.1.0",
            model_provider: "openai", timestamp: "2026-05-09T10:00:00.000Z" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-05-09T10:00:01.000Z",
        payload: { type: "message", role: "user", content: "do a thing" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-05-09T10:00:02.000Z",
        payload: { type: "function_call", name: "exec_command", call_id: "call-1",
            arguments: JSON.stringify({ cmd: "git status --short" }) } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-05-09T10:00:03.000Z",
        payload: { type: "function_call_output", call_id: "call-1", output: "ok" } }),
];

describe("Codex re-ingest on real DuckDB", () => {
    dtest("replaces the session event set without duplicates", async () => {
        const extracted = __testExtractCodexJsonlLines(lines);
        expect(extracted).not.toBeNull();
        const batch = toCodexNormalizedBatch(extracted!, 1200);
        let counts: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-codex-reingest-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeNormalizedTranscriptBatch(write, batch);
                yield* writeNormalizedTranscriptBatch(write, batch);
                counts = (yield* write.rows(Schema.Struct({
                    sessions: Schema.BigInt, events: Schema.BigInt,
                    turns: Schema.BigInt, calls: Schema.BigInt,
                }), `SELECT (SELECT count(*) FROM agent_session) AS sessions,
                    (SELECT count(*) FROM agent_event) AS events,
                    (SELECT count(*) FROM turn) AS turns,
                    (SELECT count(*) FROM tool_call) AS calls`))[0];
            }),
        ));
        expect(counts).toEqual({
            sessions: 1n, events: BigInt(batch.events.length),
            turns: BigInt(batch.turns.length), calls: BigInt(batch.toolCalls.length),
        });
    });
});
