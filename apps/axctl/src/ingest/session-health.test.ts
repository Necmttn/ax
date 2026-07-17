import { describe, expect, test } from "bun:test";
import {
    __testBuildSessionHealthRows,
    __testNormalizeFirstSuperpowersAt,
    __testTokenUsageStatement,
    __testWorkflowEpochStatements,
} from "./session-health.ts";

describe("session health derivation", () => {
    test("uses Claude usage metrics when available", () => {
        const rows = __testBuildSessionHealthRows({
            firstSuperpowersAt: "2026-05-01T00:00:00.000Z",
            sessions: [{
                id: "session:`s1`",
                source: "claude",
                model: "opus",
                started_at: "2026-05-02T00:00:00.000Z",
                ended_at: "2026-05-02T00:10:00.000Z",
            }],
            turns: [
                { session: "session:`s1`", role: "user", text_excerpt: "stop, verify the main branch guardrail" },
                { session: "session:`s1`", role: "assistant", text_excerpt: "Done" },
            ],
            toolCalls: [
                { session: "session:`s1`", name: "Task", input_json: "{\"prompt\":\"large subagent task\"}", has_error: false },
                { session: "session:`s1`", name: "Bash", command_norm: "bun test", output_excerpt: "ok", has_error: false },
            ],
            planSnapshots: [{ session: "session:`s1`" }],
            insightMetrics: [{
                subject_id: "s1",
                metrics: JSON.stringify({
                    input_tokens: 1000,
                    output_tokens: 250,
                    cache_read_input_tokens: 500,
                    cache_creation_input_tokens: 100,
                    context_window: 200000,
                }),
            }],
        });

        expect(rows.usages[0]).toMatchObject({
            source: "claude",
            workflowEpoch: "superpowers",
            promptTokens: 1000,
            completionTokens: 250,
            cacheReadInputTokens: 500,
            estimatedTokens: 1250,
            contextWindow: 200000,
            labels: {
                token_source_quality: "explicit",
                token_source_detail: "usage_metadata",
                model_source_quality: "explicit",
            },
        });
        expect(rows.health[0]).toMatchObject({
            turns: 2,
            toolCalls: 2,
            interruptions: 1,
            subagentDispatches: 1,
            planSnapshots: 1,
            cacheReadRatio: 0.5,
            cacheCreationRatio: 0.1,
        });
    });

    test("falls back to transcript byte token estimates for Codex", () => {
        const rows = __testBuildSessionHealthRows({
            firstSuperpowersAt: "2026-05-01T00:00:00.000Z",
            sessions: [{
                id: "session:`s2`",
                source: "codex",
                started_at: "2026-04-25T00:00:00.000Z",
                ended_at: "2026-04-25T00:01:00.000Z",
            }],
            turns: [{ session: "session:`s2`", role: "user", text_excerpt: "hello world" }],
            toolCalls: [{ session: "session:`s2`", name: "shell", output_excerpt: "abcd", has_error: true }],
            planSnapshots: [],
            insightMetrics: [],
        });

        expect(rows.usages[0]?.workflowEpoch).toBe("gsd");
        expect(rows.usages[0]?.estimatedTokens).toBe(Math.ceil(15 / 4));
        expect(rows.usages[0]?.labels).toMatchObject({
            token_source_quality: "estimate",
            token_source_detail: "transcript_byte_estimate",
            model_source_quality: "unavailable",
        });
        expect(rows.health[0]).toMatchObject({
            source: "codex",
            toolErrors: 1,
            contextPressure: "low",
        });
    });

    test("token usage statement preserves existing provider actual token fields over byte estimates", () => {
        const statement = __testTokenUsageStatement({
            sessionKey: "pi-session",
            source: "pi",
            workflowEpoch: null,
            model: "gpt-5.5",
            promptTokens: null,
            completionTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            estimatedTokens: 42,
            transcriptBytes: 168,
            contextWindow: null,
            labels: { source: "session_health", token_source: "byte_estimate" },
            metrics: { turn_bytes: 168 },
            ts: "2026-05-29T07:00:00.000Z",
        });

        expect(statement).toContain("prompt_tokens: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN prompt_tokens ELSE NONE END");
        expect(statement).toContain("completion_tokens: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN completion_tokens ELSE NONE END");
        expect(statement).toContain("cache_creation_input_tokens: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN cache_creation_input_tokens ELSE NONE END");
        expect(statement).toContain("cache_read_input_tokens: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN cache_read_input_tokens ELSE NONE END");
        expect(statement).toContain("estimated_tokens: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN estimated_tokens ELSE 42 END");
        expect(statement).toContain("labels: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN labels ELSE");
        expect(statement).toContain("metrics: IF prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE THEN metrics ELSE");
        expect(statement).toContain('model: "gpt-5.5"');
    });

    test("token usage statement preserves an existing model when session.model is null", () => {
        const statement = __testTokenUsageStatement({
            sessionKey: "claude-subagent-abc",
            source: "claude-subagent",
            workflowEpoch: null,
            model: null,
            promptTokens: null,
            completionTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            estimatedTokens: 42,
            transcriptBytes: 168,
            contextWindow: null,
            labels: { source: "session_health", token_source: "byte_estimate" },
            metrics: { turn_bytes: 168 },
            ts: "2026-05-29T07:00:00.000Z",
        });

        expect(statement).toContain("model: IF model != NONE THEN model ELSE NONE END");
    });
});

describe("session health NONE-safety (#680)", () => {
    const origWarn = console.warn;

    test("skips a session with no started_at (no epoch warn, no row)", () => {
        const warnings: unknown[] = [];
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
            const rows = __testBuildSessionHealthRows({
                firstSuperpowersAt: null,
                // Half-ingested codex session: started_at hasn't landed yet.
                sessions: [{ id: "session:`half`", source: "codex" }],
                turns: [{ session: "session:`half`", role: "user", text_excerpt: "hi" }],
                toolCalls: [],
                planSnapshots: [],
                insightMetrics: [],
            });
            expect(rows.usages).toHaveLength(0);
            expect(rows.health).toHaveLength(0);
            expect(warnings).toHaveLength(0);
        } finally {
            console.warn = origWarn;
        }
    });

    test("still emits rows for a session WITH started_at alongside a half-ingested one", () => {
        const rows = __testBuildSessionHealthRows({
            firstSuperpowersAt: null,
            sessions: [
                { id: "session:`ok`", source: "codex", started_at: "2026-05-02T00:00:00.000Z" },
                { id: "session:`half`", source: "codex" },
            ],
            turns: [],
            toolCalls: [],
            planSnapshots: [],
            insightMetrics: [],
        });
        expect(rows.usages).toHaveLength(1);
        expect(rows.health).toHaveLength(1);
        expect(rows.usages[0].sessionKey).toBe("ok");
    });
});

describe("session health empty superpowers invocations", () => {
    test("rejects SurrealDB's empty-set max datetime sentinel", () => {
        const firstSuperpowersAt = __testNormalizeFirstSuperpowersAt("+262142-12-31T23:59:59.999999999Z");

        expect(firstSuperpowersAt).toBeNull();
        expect(__testNormalizeFirstSuperpowersAt(null)).toBeNull();
        expect(__testNormalizeFirstSuperpowersAt("2026-07-01T00:00:00.000Z"))
            .toBe("2026-07-01T00:00:00.000Z");

        const rows = __testBuildSessionHealthRows({
            firstSuperpowersAt,
            sessions: [{
                id: "session:`without-superpowers`",
                source: "codex",
                started_at: "2026-07-17T00:00:00.000Z",
            }],
            turns: [],
            toolCalls: [],
            planSnapshots: [],
            insightMetrics: [],
        });
        expect(rows.usages[0]?.workflowEpoch).toBeNull();

        const statements = __testWorkflowEpochStatements(firstSuperpowersAt);
        expect(statements[0]).toContain("ends_at: NONE");
        expect(statements.join("\n")).not.toContain("262142");
    });
});
