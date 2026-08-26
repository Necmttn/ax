import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { agentEventRecordKey } from "./provider-events.ts";
import { SkillName } from "@ax/lib/brands";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import {
    __testCompactCodexToolCall,
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
    __testWriteCodexTokenUsage,
    codexConcurrency,
    codexFlushEvery,
    codexPayloadMaxBytes,
    codexProgressEvery,
    shouldSnapshotCodexRaw,
    toCodexNormalizedBatch,
} from "./codex.ts";
import { builtInPricingCatalog, estimateCost, normalizeModelName } from "./model-pricing.ts";
import type { ModelPricing } from "./model-pricing.ts";
import { codexSourceForThread } from "./source-origin.ts";

const normalizedCodexBatch = (
    batch: Parameters<typeof toCodexNormalizedBatch>[0],
    payloadMaxBytes: number,
) => toCodexNormalizedBatch(batch, payloadMaxBytes);

// Fixture skill names are plain string literals; brand via the schema constructor.
const sn = (s: string): SkillName => SkillName.make(s);

describe("Codex transcript extraction", () => {
    test("skips oversized raw artifact snapshots", () => {
        expect(shouldSnapshotCodexRaw(1024, 1024)).toBe(true);
        expect(shouldSnapshotCodexRaw(1025, 1024)).toBe(false);
    });

    test("codexProgressEvery rejects invalid values", () => {
        expect(codexProgressEvery(undefined)).toBe(10);
        expect(codexProgressEvery("5")).toBe(5);
        expect(codexProgressEvery("0")).toBe(10);
        expect(codexProgressEvery("nope")).toBe(10);
    });

    test("codexFlushEvery rejects invalid values", () => {
        expect(codexFlushEvery(undefined)).toBe(500);
        expect(codexFlushEvery("1000")).toBe(1000);
        expect(codexFlushEvery("0")).toBe(500);
        expect(codexFlushEvery("nope")).toBe(500);
    });

    test("codexConcurrency rejects invalid values", () => {
        expect(codexConcurrency(undefined)).toBe(1);
        expect(codexConcurrency("3")).toBe(3);
        expect(codexConcurrency("0")).toBe(1);
        expect(codexConcurrency("nope")).toBe(1);
    });

    test("codexPayloadMaxBytes rejects invalid values", () => {
        expect(codexPayloadMaxBytes(undefined)).toBe(1200);
        expect(codexPayloadMaxBytes("0")).toBe(0);
        expect(codexPayloadMaxBytes("4096")).toBe(4096);
        expect(codexPayloadMaxBytes("-1")).toBe(1200);
        expect(codexPayloadMaxBytes("nope")).toBe(1200);
    });

    test("compacts oversized Codex tool call payloads for storage", () => {
        const compacted = __testCompactCodexToolCall({
            provider: "codex",
            toolName: "exec_command",
            toolKind: "builtin",
            sessionId: "session-1",
            seq: 1,
            turnKey: turnRecordKey("session-1", 1),
            callId: "call-1",
            ts: "2026-05-09T10:00:01.000Z",
            cwd: "/tmp/project",
            inputJson: { cmd: "printf hello" },
            outputJson: "x".repeat(2000),
            rawJson: {
                type: "function_call",
                name: "exec_command",
                call_id: "call-1",
                arguments: "x".repeat(2000),
            },
            outputExcerpt: "hello",
            hasError: false,
        }, 64);

        expect(compacted.inputJson).toEqual({ cmd: "printf hello" });
        expect(compacted.outputJson).toMatchObject({
            truncated: true,
            bytes: expect.any(Number),
            excerpt: expect.stringContaining("x"),
        });
        expect(compacted.rawJson).toMatchObject({
            truncated: true,
            bytes: expect.any(Number),
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
        });
        expect(compacted.outputExcerpt).toBe("hello");
    });

    test("a forked/subagent rollout keeps its OWN id, not the fork source's (#796)", () => {
        // Codex writes TWO adjacent session_meta records for a forked or
        // subagent thread: the file's own first, then the fork source's as a
        // header. Taking the second gave the file the ancestor's identity, so
        // the file's session was never written and its turns collided with the
        // ancestor's own file on turnRecordKey(session, seq).
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-14T15:28:13.994Z",
                payload: {
                    id: "child-thread",
                    forked_from_id: "parent-thread",
                    thread_source: "subagent",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-14T15:28:13.905Z",
                    source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread" } } },
                },
            }),
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-14T15:28:13.996Z",
                payload: {
                    id: "parent-thread",
                    thread_source: "user",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-14T14:34:35.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-14T15:28:20.000Z",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
            }),
        ]);

        expect(extracted?.session.id).toBe("child-thread");
        expect(extracted?.session.thread_source).toBe("subagent");
        // Lineage survives even though the top-level field is absent here -
        // it is read from the nested thread_spawn / forked_from_id fallbacks.
        expect(extracted?.session.parent_thread_id).toBe("parent-thread");
        // `every` on an empty array is vacuously true, so pin the count first.
        expect(extracted?.turns.length).toBeGreaterThan(0);
        expect(extracted?.turns.every((turn) => turn.session === "child-thread")).toBe(true);
    });

    test("extracts turn_context model and token_count usage rollup", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-usage",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "openai",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "turn_context",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    model: "gpt-5.5",
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        model_context_window: 258400,
                        total_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 250,
                            output_tokens: 125,
                            reasoning_output_tokens: 75,
                            total_tokens: 1200,
                        },
                        last_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 250,
                            output_tokens: 125,
                            reasoning_output_tokens: 75,
                            total_tokens: 1200,
                        },
                    },
                },
            }),
        ]);

        expect(extracted?.session.model).toBe("gpt-5.5");
        expect(extracted?.tokenUsage).toMatchObject({
            model: "gpt-5.5",
            promptTokens: 1000,
            completionTokens: 125,
            cacheReadInputTokens: 250,
            estimatedTokens: 1200,
            contextWindow: 258400,
        });
        expect(extracted?.turnTokenUsages).toEqual([]);

        expect(normalizedCodexBatch(extracted!, 1200).sessions[0]?.model).toBe("gpt-5.5");
    });

    test("tags subagent sessions (thread_source) with source codex-subagent", () => {
        const lines = (threadSource: string | null) => [
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-06-16T22:53:06.000Z",
                payload: {
                    id: "codex-sub-1",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "openai",
                    model: "gpt-5.5",
                    ...(threadSource ? { thread_source: threadSource, parent_thread_id: "codex-parent-1" } : {}),
                    timestamp: "2026-06-16T22:53:06.000Z",
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-06-16T22:53:08.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 125, reasoning_output_tokens: 75, total_tokens: 1200 },
                        last_token_usage: { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 125, reasoning_output_tokens: 75, total_tokens: 1200 },
                    },
                },
            }),
        ];

        expect(codexSourceForThread(__testExtractCodexJsonlLines(lines("subagent"))!.session.thread_source))
            .toBe("codex-subagent");
        expect(codexSourceForThread(__testExtractCodexJsonlLines(lines("user"))!.session.thread_source))
            .toBe("codex");

        // No thread_source (older transcripts) defaults to main codex.
        expect(codexSourceForThread(__testExtractCodexJsonlLines(lines(null))!.session.thread_source))
            .toBe("codex");
    });

    test("does not treat model_provider as a concrete model", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-provider-only",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "openai",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        last_token_usage: {
                            input_tokens: 1000,
                            output_tokens: 125,
                            total_tokens: 1125,
                        },
                    },
                },
            }),
        ]);

        expect(extracted?.session.model).toBeNull();
        expect(normalizedCodexBatch(extracted!, 1200).sessions[0]?.model).toBeNull();
    });


    test("extracts input_text messages and classifies user task and context turns", () => {
        const longTaskText = `Trace the user prompt ingestion path.\n${"y".repeat(620)}`;
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-user-text",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "message",
                    role: "developer",
                    content: [
                        {
                            type: "input_text",
                            text: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: longTaskText,
                        },
                    ],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(
            extracted.turns.map((turn) => ({
                role: turn.role,
                text: turn.text,
                text_excerpt: turn.text_excerpt,
                message_kind: turn.message_kind,
                intent_kind: turn.intent_kind,
            })),
        ).toEqual([
            {
                role: "developer",
                text: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                text_excerpt: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                message_kind: "system_or_developer",
                intent_kind: "system_context",
            },
            {
                role: "user",
                text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                text_excerpt: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                message_kind: "context",
                intent_kind: "system_context",
            },
            {
                role: "user",
                text: longTaskText,
                text_excerpt: longTaskText.slice(0, 500),
                message_kind: "task",
                intent_kind: "organic_task",
            },
        ]);
        expect(extracted.providerEvents.map((event) => ({
            provider: event.provider,
            providerSessionId: event.providerSessionId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 1,
                type: "message",
                role: "developer",
                textExcerpt: "<permissions instructions>\nFilesystem sandboxing is read-only.",
            },
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 2,
                type: "message",
                role: "user",
                textExcerpt: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
            },
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 3,
                type: "message",
                role: "user",
                textExcerpt: longTaskText.slice(0, 500),
            },
        ]);
    });

    test("writes explicit Codex token_count usage with source quality labels", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-token-count",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "gpt-5-codex",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-05-09T10:00:05.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: {
                            input_tokens: 123,
                            cached_input_tokens: 45,
                            output_tokens: 67,
                            reasoning_output_tokens: 8,
                            total_tokens: 190,
                        },
                        last_token_usage: {
                            input_tokens: 123,
                            cached_input_tokens: 45,
                            output_tokens: 67,
                            reasoning_output_tokens: 8,
                            total_tokens: 190,
                        },
                        model_context_window: 258400,
                    },
                },
            }),
        ]);

        expect(extracted?.tokenUsage).toMatchObject({
            promptTokens: 123,
            completionTokens: 67,
            cacheReadInputTokens: 45,
            estimatedTokens: 190,
            contextWindow: 258400,
            tokenCountEvents: 1,
        });
        expect(extracted?.turnTokenUsages).toEqual([]);

        expect(extracted?.tokenUsage?.totalTokenUsage).toMatchObject({
            input_tokens: 123,
            cached_input_tokens: 45,
            output_tokens: 67,
            total_tokens: 190,
        });
    });

    test("writes Codex per-turn token usage for token_count after a response item", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-turn-usage",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "gpt-5",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 800,
                            output_tokens: 100,
                            total_tokens: 1100,
                        },
                        last_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 800,
                            output_tokens: 100,
                            total_tokens: 1100,
                        },
                    },
                },
            }),
        ]);

        expect(extracted?.turnTokenUsages[0]).toMatchObject({
            seq: 1,
            promptTokens: 1000,
            cacheReadInputTokens: 800,
            freshInputTokens: 200,
            completionTokens: 100,
            usageQuality: "provider_turn",
        });
        expect(extracted?.turnTokenUsages[0]?.usageSource).toBe("codex_token_count.last_token_usage");
    });

    test("writes merged catalog pricing for an upstream-only Codex model", async () => {
        const model = "gpt-upstream-only";
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-merged-price",
                    cwd: "/tmp",
                    model_provider: "openai",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "turn_context",
                timestamp: "2026-05-09T10:00:00.500Z",
                payload: { model },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: { input_tokens: 100_000, output_tokens: 10_000, total_tokens: 110_000 },
                        last_token_usage: { input_tokens: 100_000, output_tokens: 10_000, total_tokens: 110_000 },
                    },
                },
            }),
        ]);
        const catalog = new Map<string, ModelPricing>([[model, {
            provider: "openai",
            inputPerMillionUsd: 2,
            outputPerMillionUsd: 10,
            cacheCreationPerMillionUsd: 2.5,
            cacheReadPerMillionUsd: 0.2,
            fastMultiplier: 1,
            pricingSource: "litellm",
        }]]);
        const written = new Map<string, Record<string, unknown>[]>();
        const write = {
            put: (table: string, row: Record<string, unknown>) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), row]);
            }),
            putMany: (table: string, rows: Record<string, unknown>[]) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), ...rows]);
            }),
        };

        await Effect.runPromise(__testWriteCodexTokenUsage(
            write as never,
            extracted!.tokenUsage,
            extracted!.turnTokenUsages,
            "codex",
            catalog,
        ));

        expect(written.get("turn_token_usage")?.[0]?.estimated_cost_usd as number).toBeCloseTo(0.3, 6);
        expect(written.get("turn_token_usage")?.[0]?.pricing_source).toBe("litellm");
    });

    test("prices a mixed-model Codex session from its turn costs", async () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: { id: "codex-mixed-price", cwd: "/tmp", model_provider: "openai" },
            }),
            JSON.stringify({ type: "turn_context", payload: { model: "claude-sonnet-4" } }),
            JSON.stringify({
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "one" }] },
            }),
            JSON.stringify({
                type: "event_msg",
                payload: { type: "token_count", info: {
                    total_token_usage: { input_tokens: 2_000_000, output_tokens: 0, total_tokens: 2_000_000 },
                    last_token_usage: { input_tokens: 2_000_000, output_tokens: 0, total_tokens: 2_000_000 },
                } },
            }),
            JSON.stringify({ type: "turn_context", payload: { model: "claude-fable-5" } }),
            JSON.stringify({
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] },
            }),
            JSON.stringify({
                type: "event_msg",
                payload: { type: "token_count", info: {
                    total_token_usage: { input_tokens: 2_100_000, output_tokens: 0, total_tokens: 2_100_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 0, total_tokens: 100_000 },
                } },
            }),
        ]);
        const written = new Map<string, Record<string, unknown>[]>();
        const write = {
            put: (table: string, row: Record<string, unknown>) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), row]);
            }),
            putMany: (table: string, rows: Record<string, unknown>[]) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), ...rows]);
            }),
        };

        await Effect.runPromise(__testWriteCodexTokenUsage(
            write as never,
            extracted!.tokenUsage,
            extracted!.turnTokenUsages,
            "codex",
            builtInPricingCatalog(),
        ));

        const session = written.get("session_token_usage")?.[0];
        expect(session?.model).toBe("claude-fable-5");
        expect(session?.estimated_cost_usd).toBe(7);
    });

    test("prices session usage that has no turn row (#999)", async () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-08-21T00:00:00.000Z",
                payload: { id: "codex-pre-turn-price", cwd: "/tmp", model_provider: "openai" },
            }),
            JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
            JSON.stringify({
                type: "event_msg",
                payload: { type: "token_count", info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
                    last_token_usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
                } },
            }),
            JSON.stringify({
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
            }),
            JSON.stringify({
                type: "event_msg",
                payload: { type: "token_count", info: {
                    total_token_usage: { input_tokens: 110, output_tokens: 0, total_tokens: 110 },
                    last_token_usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
                } },
            }),
        ]);
        const written = new Map<string, Record<string, unknown>[]>();
        const write = {
            put: (table: string, row: Record<string, unknown>) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), row]);
            }),
            putMany: (table: string, rows: Record<string, unknown>[]) => Effect.sync(() => {
                written.set(table, [...(written.get(table) ?? []), ...rows]);
            }),
        };
        const catalog = new Map<string, ModelPricing>([["test-model", {
            provider: "test",
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 1,
            cacheCreationPerMillionUsd: 1,
            cacheReadPerMillionUsd: 1,
            fastMultiplier: 1,
            pricingSource: "test-catalog",
        }]]);

        expect(extracted?.tokenUsage?.promptTokens).toBe(110);
        expect(extracted?.turnTokenUsages.map((row) => row.promptTokens)).toEqual([10]);

        await Effect.runPromise(__testWriteCodexTokenUsage(
            write as never,
            extracted!.tokenUsage,
            extracted!.turnTokenUsages,
            "codex",
            catalog,
        ));

        expect(written.get("session_token_usage")?.[0]?.estimated_cost_usd).toBeCloseTo(0.00011, 12);
    });

    // Plan 003 fix round 1: `codexTurnTokenUsageFromPayload`'s `first_total`
    // outcome (no previous cumulative snapshot to diff against) returns the
    // FULL cumulative total_token_usage.input_tokens unchanged - a sum by
    // construction, not one request's context. It must not trigger the
    // long-context tier even when that cumulative figure exceeds 200k. The
    // very next turn's `derived_delta` outcome (a real diff against a
    // previous snapshot) is genuinely request-grain and MUST still trigger
    // the tier when its own delta exceeds 200k - same freshInputTokens
    // (250k) on both turns, verifying the flag - not the token count -
    // drives the tier decision.
    test("suppresses the long-context tier on the first_total turn but not on the following derived_delta turn", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-07-01T10:00:00.000Z",
                payload: {
                    id: "codex-first-total-tier",
                    cwd: "/tmp",
                    model_provider: "openai",
                    timestamp: "2026-07-01T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "turn_context",
                timestamp: "2026-07-01T10:00:00.500Z",
                payload: { model: "gpt-5.6-terra" },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-07-01T10:00:01.000Z",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "turn 1" }] },
            }),
            // First token_count event this session: no last_token_usage, and
            // no previous total_token_usage to diff against -> `first_total`.
            // Its cumulative input_tokens (250k) EXCEEDS the 200k threshold -
            // exactly the resumed/forked-rollout shape the fix targets.
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-07-01T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: { input_tokens: 250_000, output_tokens: 0, total_tokens: 250_000 },
                    },
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-07-01T10:00:03.000Z",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "turn 2" }] },
            }),
            // Second token_count event: still no last_token_usage, but NOW a
            // previous snapshot exists -> `derived_delta`. Delta is
            // 500k - 250k = 250k, the SAME fresh-input magnitude as turn 1.
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-07-01T10:00:04.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: { input_tokens: 500_000, output_tokens: 0, total_tokens: 500_000 },
                    },
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;
        expect(extracted.turnTokenUsages).toHaveLength(2);
        expect(extracted.turnTokenUsages[0]).toMatchObject({
            seq: 1,
            usageQuality: "first_total",
            promptTokens: 250_000,
            freshInputTokens: 250_000,
        });
        expect(extracted.turnTokenUsages[1]).toMatchObject({
            seq: 2,
            usageQuality: "derived_delta",
            promptTokens: 250_000,
            freshInputTokens: 250_000,
        });

        const turn1 = extracted.turnTokenUsages[0]!;
        const turn2 = extracted.turnTokenUsages[1]!;
        const priceTurn = (turn: typeof turn1) => estimateCost({
            modelKey: normalizeModelName(turn.model),
            promptTokens: turn.promptTokens,
            completionTokens: turn.completionTokens,
            cacheCreationInputTokens: turn.cacheCreationInputTokens,
            cacheReadInputTokens: turn.cacheReadInputTokens,
            estimatedTokens: turn.estimatedTokens,
            aggregated: turn.usageQuality === "first_total",
        });

        // gpt-5.6-terra: base input $2/M, tier input $4/M above 200k.
        // first_total (aggregated, suppressed): 250k @ $2/M = $0.5 flat, base
        // rate - NOT the $1 the tier would have produced.
        expect(priceTurn(turn1).inputUsd).toBe(0.5);
        expect(priceTurn(turn1).totalUsd).toBe(0.5);
        // derived_delta (request-grain, tier applies): 250k @ $4/M = $1 -
        // same fresh-input token count as turn 1, different (correct)
        // dollar value because the grain differs.
        expect(priceTurn(turn2).inputUsd).toBe(1);
        expect(priceTurn(turn2).totalUsd).toBe(1);
    });

    test("links adjacent provider events with linear parent edges while preserving tool-result parents", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T12:00:00.000Z",
                payload: {
                    id: "codex-linear",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T12:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:01.000Z",
                payload: {
                    type: "message",
                    id: "msg-user",
                    role: "user",
                    content: [{ type: "input_text", text: "Run a command." }],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call-linear",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call-linear",
                    output: "ok",
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
            parentProviderEventIds: event.parentProviderEventIds,
        }))).toEqual([
            {
                providerEventId: "msg-user",
                parentProviderEventId: undefined,
                parentProviderEventIds: undefined,
            },
            {
                providerEventId: "call-linear",
                parentProviderEventId: "msg-user",
                parentProviderEventIds: undefined,
            },
            {
                providerEventId: "function_call_output:call-linear",
                parentProviderEventId: "call-linear",
                parentProviderEventIds: undefined,
            },
        ]);
    });

    test("extracts custom_tool_call apply_patch items as edit tool calls", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T13:00:00.000Z",
                payload: {
                    id: "codex-patch",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T13:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T13:00:01.000Z",
                payload: {
                    type: "custom_tool_call",
                    status: "completed",
                    name: "apply_patch",
                    call_id: "call-patch",
                    input: "*** Begin Patch\n*** Update File: a.ts\n+added line\n-removed line\n*** End Patch\n",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T13:00:02.000Z",
                payload: {
                    type: "custom_tool_call_output",
                    call_id: "call-patch",
                    output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM a.ts",
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.toolCalls).toHaveLength(1);
        const call = extracted.toolCalls[0]!;
        expect(call.toolName).toBe("apply_patch");
        expect(call.callId).toBe("call-patch");
        expect(call.inputJson).toEqual({ patch: expect.stringContaining("*** Begin Patch") });
        expect(call.outputExcerpt ?? "").toContain("Success.");

        const toolTurn = extracted.turns.find((turn) => turn.has_tool_use);
        expect(toolTurn).toMatchObject({ role: "tool_call" });
    });

    test("exec custom_tool_call output as an input_text array is decoded to plain text and not flagged as an error", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T14:00:00.000Z",
                payload: {
                    id: "codex-exec-array",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T14:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T14:00:01.000Z",
                payload: {
                    type: "custom_tool_call",
                    status: "completed",
                    name: "exec",
                    call_id: "call-exec-ok",
                    input: "bun test error-handling.test.ts",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T14:00:02.000Z",
                payload: {
                    type: "custom_tool_call_output",
                    call_id: "call-exec-ok",
                    output: [
                        {
                            type: "input_text",
                            text:
                                "Script completed\n" +
                                "Wall time 0.2 seconds\n" +
                                "Output:\n",
                        },
                        {
                            type: "input_text",
                            text:
                                "tests/error-handling.test.ts .... 12 passed, 0 failed\n" +
                                "0 \"not found\" warnings",
                        },
                    ],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const call = extracted.toolCalls.find((c) => c.callId === "call-exec-ok");
        expect(call).toBeDefined();
        if (!call) return;
        expect(call.toolName).toBe("exec");
        expect(call.hasError).toBe(false);
        expect(call.errorText).toBeNull();
        expect(call.outputExcerpt ?? "").toContain("12 passed, 0 failed");
        expect(call.outputExcerpt ?? "").not.toContain('"type":"input_text"');
        expect(call.outputExcerpt ?? "").not.toContain("[{");
    });

    test("exec custom_tool_call Script failed output as an input_text array remains an error", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T14:10:00.000Z",
                payload: {
                    id: "codex-exec-array-fail",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T14:10:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T14:10:01.000Z",
                payload: {
                    type: "custom_tool_call",
                    status: "completed",
                    name: "exec",
                    call_id: "call-exec-fail",
                    input: "bun test error-handling.test.ts",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T14:10:02.000Z",
                payload: {
                    type: "custom_tool_call_output",
                    call_id: "call-exec-fail",
                    output: [
                        {
                            type: "input_text",
                            text:
                                "Script failed in 0.1 seconds:\n" +
                                "tests/error-handling.test.ts .... 1 failed\n" +
                                "Wall time: 0.1 seconds",
                        },
                    ],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const call = extracted.toolCalls.find((c) => c.callId === "call-exec-fail");
        expect(call).toBeDefined();
        if (!call) return;
        expect(call.hasError).toBe(true);
    });

    test("extracts function calls, matched outputs, synthetic skill relations, and update_plan snapshots", () => {
        const execOutput =
            "Chunk ID: abc\nWall time: 0.2000 seconds\nProcess exited with code 1\nOriginal token count: 30\nOutput:\nfatal: not a git repository\n";
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-session",
                    cwd: "/Users/necmttn/Projects/ax",
                    cli_version: "0.1.0",
                    model_provider: "openai",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_exec",
                    arguments: JSON.stringify({
                        cmd: "git status --short",
                        workdir: "/Users/necmttn/Projects/ax",
                    }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_exec",
                    output: execOutput,
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan",
                    arguments: JSON.stringify({
                        explanation: "Tracking task progress.",
                        plan: [
                            { step: "Inspect Codex ingestion", status: "completed" },
                            { step: "Write evidence graph records", status: "in_progress" },
                        ],
                    }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.turns.map((turn) => [turn.seq, turn.role, turn.has_tool_use])).toEqual([
            [1, "tool_call", true],
            [2, "function_call_output", false],
            [3, "tool_call", true],
        ]);

        expect(extracted.invocations).toEqual([
            {
                session: "codex-session",
                seq: 1,
                ts: "2026-05-09T10:00:01.000Z",
                skill: sn("codex:exec_command"),
                args: JSON.stringify({
                    cmd: "git status --short",
                    workdir: "/Users/necmttn/Projects/ax",
                }),
            },
            {
                session: "codex-session",
                seq: 3,
                ts: "2026-05-09T10:00:03.000Z",
                skill: sn("codex:update_plan"),
                args: JSON.stringify({
                    explanation: "Tracking task progress.",
                    plan: [
                        { step: "Inspect Codex ingestion", status: "completed" },
                        { step: "Write evidence graph records", status: "in_progress" },
                    ],
                }),
            },
        ]);
        const batch = normalizedCodexBatch(extracted, 1200);
        expect(batch.syntheticSkillInvocations).toHaveLength(2);
        expect(batch.toolCallSkillRelations).toHaveLength(2);

        expect(extracted.toolCalls).toHaveLength(2);
        const execCall = extracted.toolCalls.find((call) => call.toolName === "exec_command");
        expect(execCall).toMatchObject({
            provider: "codex",
            toolKind: "builtin",
            sessionId: "codex-session",
            seq: 1,
            turnKey: turnRecordKey("codex-session", 1),
            callId: "call_exec",
            ts: "2026-05-09T10:00:01.000Z",
            cwd: "/Users/necmttn/Projects/ax",
            inputJson: {
                cmd: "git status --short",
                workdir: "/Users/necmttn/Projects/ax",
            },
            commandText: "git status --short",
            commandToolName: "git",
            commandNorm: "git status",
            outputJson: execOutput,
            outputExcerpt: "fatal: not a git repository",
            errorText: "fatal: not a git repository",
            exitCode: 1,
            durationMs: 200,
            hasError: true,
        });
        expect(execCall?.rawJson).toMatchObject({
            type: "function_call",
            name: "exec_command",
            call_id: "call_exec",
        });
        expect(execCall?.agentEventKey).toBe(agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-session",
            providerEventId: "call_exec",
            seq: 1,
        }));
        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                providerEventId: "call_exec",
                seq: 1,
                type: "function_call",
                role: "tool_call",
                textExcerpt: null,
            },
            {
                providerEventId: "function_call_output:call_exec",
                seq: 2,
                type: "function_call_output",
                role: "function_call_output",
                textExcerpt: "fatal: not a git repository",
            },
            {
                providerEventId: "call_plan",
                seq: 3,
                type: "function_call",
                role: "tool_call",
                textExcerpt: null,
            },
        ]);

        const updatePlanKey = toolCallRecordKey({
            sessionId: "codex-session",
            seq: 3,
            callId: "call_plan",
        });
        expect(extracted.skillRelations).toEqual([
            {
                toolCallKey: toolCallRecordKey({
                    sessionId: "codex-session",
                    seq: 1,
                    callId: "call_exec",
                }),
                skillName: sn("codex:exec_command"),
                ts: "2026-05-09T10:00:01.000Z",
                reason: "Codex function call",
                labels: {
                    provider: "codex",
                    toolName: "exec_command",
                    source: "transcript",
                },
                metrics: { turnSeq: 1 },
            },
            {
                toolCallKey: updatePlanKey,
                skillName: sn("codex:update_plan"),
                ts: "2026-05-09T10:00:03.000Z",
                reason: "Codex function call",
                labels: {
                    provider: "codex",
                    toolName: "update_plan",
                    source: "transcript",
                },
                metrics: { turnSeq: 3 },
            },
        ]);

        expect(extracted.planSnapshots).toHaveLength(1);
        expect(extracted.planSnapshots[0]).toMatchObject({
            sessionId: "codex-session",
            source: "codex_update_plan",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:03.000Z",
            updatedAt: "2026-05-09T10:00:03.000Z",
            ts: "2026-05-09T10:00:03.000Z",
            toolCallKey: updatePlanKey,
            explanation: "Tracking task progress.",
        });
        expect(extracted.planSnapshots[0]?.items).toEqual([
            expect.objectContaining({
                seq: 1,
                content: "Inspect Codex ingestion",
                activeForm: null,
                status: "completed",
            }),
            expect.objectContaining({
                seq: 2,
                content: "Write evidence graph records",
                activeForm: null,
                status: "in_progress",
            }),
        ]);
    });

    test("bounds large function output provider event payloads", () => {
        const largeOutputBody = "z".repeat(5000);
        const largeOutput = [
            "Chunk ID: large",
            "Wall time: 0.1000 seconds",
            "Process exited with code 0",
            "Output:",
            largeOutputBody,
        ].join("\n");
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-large-output",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_large",
                    arguments: JSON.stringify({ cmd: "printf large" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_large",
                    output: largeOutput,
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const outputEvent = extracted.providerEvents.find(
            (event) => event.type === "function_call_output",
        );
        expect(outputEvent).toBeDefined();
        if (!outputEvent) return;

        expect(outputEvent.text).toHaveLength(1200);
        expect(outputEvent.text).toBe(outputEvent.textExcerpt);
        expect(outputEvent.text).not.toBe(largeOutput);
    });

    test("streaming extraction drains completed tool calls after their output arrives", () => {
        const batches = __testStreamCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-stream-session",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_one",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_two",
                    arguments: JSON.stringify({ cmd: "git status --short" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_one",
                    output: "Chunk ID: one\nProcess exited with code 0\nOutput:\n/Users/necmttn/Projects/ax\n",
                },
            }),
        ], 2);

        expect(batches).toHaveLength(3);
        expect(batches[0]?.turns).toHaveLength(1);
        expect(batches[0]?.toolCalls).toHaveLength(0);
        expect(batches[1]?.turns).toHaveLength(2);
        expect(batches[1]?.toolCalls.map((call) => call.callId)).toEqual(["call_one"]);
        expect(batches[1]?.toolCalls[0]?.outputExcerpt).toBe("/Users/necmttn/Projects/ax");
        expect(batches[2]?.turns).toHaveLength(0);
        expect(batches[2]?.toolCalls.map((call) => call.callId)).toEqual(["call_two"]);
        expect(batches[2]?.toolCalls[0]?.outputExcerpt).toBeUndefined();
    });

    test("streaming extraction preserves parent edges when parent event flushed in an earlier batch", () => {
        const batches = __testStreamCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T12:30:00.000Z",
                payload: {
                    id: "codex-stream-parent",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T12:30:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:01.000Z",
                payload: {
                    type: "message",
                    id: "msg-before-flush",
                    role: "user",
                    content: [{ type: "input_text", text: "Run pwd." }],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call-after-flush",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call-after-flush",
                    output: "Chunk ID: out\nProcess exited with code 0\nOutput:\n/tmp\n",
                },
            }),
        ], 2);

        expect(batches).toHaveLength(2);
        expect(batches[0]?.providerEvents.map((event) => event.providerEventId)).toEqual(["msg-before-flush"]);
        expect(batches[1]?.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
        }))).toEqual([
            {
                providerEventId: "call-after-flush",
                parentProviderEventId: "msg-before-flush",
            },
            {
                providerEventId: "function_call_output:call-after-flush",
                parentProviderEventId: "call-after-flush",
            },
        ]);

        const secondBatch = normalizedCodexBatch(batches[1]!, 1200);
        const parentKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-stream-parent",
            providerEventId: "msg-before-flush",
            seq: 1,
        });
        const childKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-stream-parent",
            providerEventId: "call-after-flush",
            seq: 2,
        });

        expect(secondBatch.events.some((event) => agentEventRecordKey({
            provider: event.provider,
            providerSessionId: event.providerSessionId,
            ...(event.providerEventId == null ? {} : { providerEventId: event.providerEventId }),
            seq: event.seq,
        }) === parentKey)).toBe(false);
        expect(secondBatch.agentEventParentEdges).toContainEqual(expect.objectContaining({
            parentEventKey: parentKey,
            childEventKey: childKey,
        }));
    });

    test("turn IDs use centralized turnRecordKey format", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-id-check",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_check",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const expectedTurnKey = turnRecordKey("codex-id-check", 1);
        const execCall = extracted.toolCalls.find((c) => c.toolName === "exec_command");
        expect(execCall?.turnKey).toBe(expectedTurnKey);
    });

    test("keeps plan item keys stable when the same step sequence changes", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-plan-session",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan_1",
                    arguments: JSON.stringify({
                        plan: [{ step: "Inspect failing ingest", status: "in_progress" }],
                    }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan_2",
                    arguments: JSON.stringify({
                        plan: [{ step: "Fix plan item identity", status: "in_progress" }],
                    }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.planSnapshots).toHaveLength(2);
        expect(extracted.planSnapshots[0]?.items[0]?.key).toBe(
            extracted.planSnapshots[1]?.items[0]?.key,
        );
    });

    test("writes shared edited file evidence for apply_patch tool calls", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-29T06:00:00.000Z",
                payload: {
                    id: "codex-file-evidence",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-29T06:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-29T06:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "apply_patch",
                    call_id: "call_patch",
                    arguments: JSON.stringify({
                        patch: [
                            "*** Begin Patch",
                            "*** Update File: src/ingest/codex.ts",
                            "@@",
                            "-old",
                            "+new",
                            "*** End Patch",
                        ].join("\n"),
                    }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(normalizedCodexBatch(extracted, 1200).toolFileEvidence).toContainEqual(
            expect.objectContaining({
                kind: "edited",
                toolName: "apply_patch",
                pathSeen: "src/ingest/codex.ts",
                path: "/Users/necmttn/Projects/ax/src/ingest/codex.ts",
            }),
        );
    });
});

describe("codex compaction", () => {
    test("type:compacted produces a compaction row + provider event", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({ type: "session_meta", timestamp: "2026-05-14T15:00:00.000Z", payload: { id: "cdx-1", timestamp: "2026-05-14T15:00:00.000Z", cwd: "/tmp", originator: "test" } }),
            JSON.stringify({ type: "event_msg", timestamp: "2026-05-14T15:30:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120000 }, last_token_usage: { input_tokens: 120000, output_tokens: 20, total_tokens: 120020 }, model_context_window: 200000 } } }),
            JSON.stringify({ type: "compacted", timestamp: "2026-05-14T15:34:42.663Z", payload: { message: "", replacement_history: [{ type: "message" }, { type: "message" }] } }),
        ]);
        expect(extracted).not.toBeNull();
        if (!extracted) return;
        expect(extracted.compactions.length).toBe(1);
        const c = extracted.compactions[0]!;
        expect(c.harness).toBe("codex");
        expect(c.strategy).toBe("history_replacement");
        expect(c.keptCount).toBe(2);
        expect(c.tokensBefore).toBe(120000);
        expect(extracted.providerEvents.some((e) => e.type === "compaction")).toBe(true);

        // The compaction's agentEventKey must match the emitted provider event's key.
        const compactionEvent = extracted.providerEvents.find((e) => e.type === "compaction");
        expect(compactionEvent).toBeDefined();
        expect(c.agentEventKey).toBe(agentEventRecordKey(compactionEvent!));
    });
});

describe("codex reasoning signals", () => {
    test("captures turn_context effort and reasoning_output_tokens", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-06-13T10:00:00.000Z",
                payload: {
                    id: "codex-effort",
                    cwd: "/Users/necmttn/Projects/ax",
                    model_provider: "openai",
                    timestamp: "2026-06-13T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "turn_context",
                timestamp: "2026-06-13T10:00:01.000Z",
                payload: {
                    model: "gpt-5.5",
                    effort: "medium",
                    collaboration_mode: {
                        mode: "default",
                        settings: { model: "gpt-5.5", reasoning_effort: "medium" },
                    },
                },
            }),
            JSON.stringify({
                type: "event_msg",
                timestamp: "2026-06-13T10:00:02.000Z",
                payload: {
                    type: "token_count",
                    info: {
                        model_context_window: 258400,
                        total_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 250,
                            output_tokens: 125,
                            reasoning_output_tokens: 75,
                            total_tokens: 1200,
                        },
                        last_token_usage: {
                            input_tokens: 1000,
                            cached_input_tokens: 250,
                            output_tokens: 125,
                            reasoning_output_tokens: 75,
                            total_tokens: 1200,
                        },
                    },
                },
            }),
        ]);

        expect(extracted?.session.reasoning_effort).toBe("medium");
        expect(extracted?.tokenUsage?.reasoningOutputTokens).toBe(75);

        expect(extracted?.tokenUsage?.reasoningOutputTokens).toBe(75);
    });

    test("falls back to collaboration_mode.settings.reasoning_effort when payload.effort missing", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-06-13T10:00:00.000Z",
                payload: { id: "codex-effort-2", cwd: "/tmp", timestamp: "2026-06-13T10:00:00.000Z" },
            }),
            JSON.stringify({
                type: "turn_context",
                timestamp: "2026-06-13T10:00:01.000Z",
                payload: {
                    collaboration_mode: { mode: "plan", settings: { model: "gpt-5.5", reasoning_effort: "xhigh" } },
                },
            }),
        ]);
        expect(extracted?.session.reasoning_effort).toBe("xhigh");
    });
});
