import { describe, expect } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { makeTableSpool, withTableSpool } from "@ax/lib/duckdb/spool";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    __testStreamCodexFileBatchesTo,
    __testWriteCodexTokenUsage,
    toCodexNormalizedBatch,
} from "./codex.ts";
import { INGEST_SPOOL_TABLES, runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import { writeNormalizedTranscriptBatch } from "./normalized/transcripts.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("codex bounded spool", { requireFts: true });

const sessionId = "01911111-1111-7111-8111-111111111111";
const lines = [
    { type: "session_meta", timestamp: "2026-09-01T10:00:00.000Z", payload: {
        id: sessionId, cwd: "/tmp/codex-spool", cli_version: "0.44.1",
        model_provider: "openai", timestamp: "2026-09-01T10:00:00.000Z",
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:01.000Z", payload: {
        type: "message", role: "user", content: "inspect the files",
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:02.000Z", payload: {
        type: "function_call", name: "exec_command", call_id: "call-1",
        arguments: JSON.stringify({ cmd: "rg TODO src" }),
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:03.000Z", payload: {
        type: "function_call_output", call_id: "call-1", output: "src/a.ts:1:TODO",
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:04.000Z", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "found one" }],
    } },
    { type: "event_msg", timestamp: "2026-09-01T10:00:05.000Z", payload: {
        type: "token_count", info: {
            total_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 },
            last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 },
        },
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:06.000Z", payload: {
        type: "message", role: "user", content: "edit it",
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:07.000Z", payload: {
        type: "function_call", name: "apply_patch", call_id: "call-2", arguments: "*** Begin Patch",
    } },
    { type: "response_item", timestamp: "2026-09-01T10:00:08.000Z", payload: {
        type: "function_call_output", call_id: "call-2", output: "Done!",
    } },
].map((row) => JSON.stringify(row));

const readState = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const queries = [
            "SELECT id, session, seq::INTEGER AS seq, role, text FROM turn ORDER BY id",
            "SELECT id, session, seq::INTEGER AS seq, name, input_json, output_json FROM tool_call ORDER BY id",
            "SELECT id, agent_session, provider_event_id, parent_provider_event_id, type, role, text FROM agent_event ORDER BY id",
            "SELECT id, in_id, out_id, kind FROM agent_event_child ORDER BY id",
            "SELECT id, session, source, prompt_tokens::VARCHAR AS prompt_tokens, completion_tokens::VARCHAR AS completion_tokens FROM session_token_usage ORDER BY id",
            "SELECT id, session, seq::INTEGER AS seq, prompt_tokens::VARCHAR AS prompt_tokens, completion_tokens::VARCHAR AS completion_tokens FROM turn_token_usage ORDER BY id",
            "SELECT source_kind, size::VARCHAR AS size, sha FROM ingest_file_state ORDER BY source_kind, sha",
        ];
        const state: unknown[] = [];
        for (const sql of queries) state.push((yield* write.raw(sql)).rows);
        return state;
    });

interface ScenarioResult {
    readonly state: unknown[];
    readonly visibleBeforeFileEnd: boolean;
    readonly peakRows: number;
}

const runScenario = async (bounded: boolean) => {
    const dir = tempDir(bounded ? "codex-spool-bounded-" : "codex-spool-direct-");
    const filePath = `${dir}/rollout.jsonl`;
    await Bun.write(filePath, `${lines.join("\n")}\n`);
    const stat = await Bun.file(filePath).stat();
    const holder: { value?: ScenarioResult } = {};
    await runWithPlatform(publishCacheFixture(dir, dylibPath, (directWrite) =>
        Effect.gen(function* () {
            const spool = bounded
                ? makeTableSpool({
                    tables: INGEST_SPOOL_TABLES,
                    dir: `${dir}/spool`,
                    limits: { maxRows: 2, maxBytes: 512 },
                })
                : undefined;
            const write = spool === undefined ? directWrite : withTableSpool(directWrite, spool);
            let firstBatch = true;
            let visibleBeforeFileEnd = false;
            const sessionUsages = new Map<number, Parameters<typeof __testWriteCodexTokenUsage>[2][number]>();
            yield* runJsonlProviderFiles(write, {
                candidates: [{ path: filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }],
                sourceKind: "codex_session",
                forceEnv: "AX_REDERIVE_CODEX_TEST",
                source: "codex",
                contentHash: true,
                ...(spool === undefined ? {} : { spool }),
                processFile: () =>
                    __testStreamCodexFileBatchesTo(filePath, 3, (batch, final) =>
                        Effect.gen(function* () {
                            yield* writeNormalizedTranscriptBatch(write, toCodexNormalizedBatch(batch, 10_000), {
                                clearExisting: firstBatch,
                            });
                            firstBatch = false;
                            for (const usage of batch.turnTokenUsages) sessionUsages.set(usage.seq, usage);
                            yield* __testWriteCodexTokenUsage(
                                write,
                                batch.tokenUsage,
                                batch.turnTokenUsages,
                                "codex",
                                new Map(),
                                [...sessionUsages.values()],
                            );
                            const count = (yield* directWrite.raw("SELECT count(*) AS n FROM tool_call")).rows[0]!["n"];
                            if (!final && typeof count === "bigint" && count > 0n) visibleBeforeFileEnd = true;
                        }),
                    ).pipe(Effect.as(true)),
            });
            holder.value = {
                state: yield* readState(directWrite),
                visibleBeforeFileEnd,
                peakRows: spool?.totals().peakPendingRows ?? 0,
            };
        }).pipe(Effect.provide(BunFileSystem.layer)),
    ));
    if (holder.value === undefined) throw new Error("scenario did not complete");
    return holder.value;
};

describe("Codex parser to bounded spool", () => {
    dtest("writes during file streaming and matches the direct database result", async () => {
        const direct = await runScenario(false);
        const bounded = await runScenario(true);
        expect(bounded.visibleBeforeFileEnd).toBe(true);
        expect(bounded.peakRows).toBeLessThanOrEqual(2);
        expect(bounded.state).toEqual(direct.state);
    });
});
