import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
    SessionCanvasPayload,
    SessionComparePayload,
    SessionListResponse,
    SessionOrchestration,
    SessionSummary,
} from "@ax/lib/shared/api-contract";

/**
 * Encode regression for the bounded sessions payloads (Schema.Struct, not
 * Class - see recall-encode.test.ts). Plain handler objects must encode with
 * full field sets; CI has no DB so these synthetic-value tests are the guard.
 */
const roundtrip = (schema: Schema.Top, value: unknown): Promise<unknown> =>
    Effect.runPromise(
        Schema.encodeUnknownEffect(Schema.toCodecJson(schema as never))(value) as Effect.Effect<unknown>,
    );

const listRow = {
    id: "s1", project: null, source: "claude", cwd: null, model: null,
    started_at: null, ended_at: null, has_raw_file: true, turn_count: 5,
    parent_session: null, direct_children_count: 2, cost_usd: null, burn_buckets: null,
    friction: null, signal: "clean" as const, produced_commits: null, reverted_commits: null,
    lines_added: null, lines_removed: null, is_live: false,
};

describe("sessions payload encode", () => {
    test("SessionListResponse with a fully-enriched row", async () => {
        const back = await roundtrip(SessionListResponse, {
            sessions: [listRow], total_count: 1, burn_p90: 608.3,
            window: { offset: 0, limit: 200 },
        }) as { sessions: Array<{ signal: string; direct_children_count?: number }> };
        expect(back.sessions[0]?.signal).toBe("clean");
        expect(back.sessions[0]?.direct_children_count).toBe(2);
    });

    test("SessionSummary + SessionOrchestration", async () => {
        await roundtrip(SessionSummary, {
            session_id: "s1", task: null, first_ask: null, last_assistant: null,
            correction: null, turns: 3, tokens: null, cost_usd: null, model: null,
            subagents: 1, tools: [{ name: "Bash", count: 4 }],
        });
        await roundtrip(SessionOrchestration, {
            session_id: "s1", label: "x", started_at: null, ended_at: null, wait_pct: 0.2,
            subagents: [{ id: "a", nickname: null, task: null, started_at: null, ended_at: null, tone: "quick", duration_ms: null }],
        });
        expect(true).toBe(true);
    });

    test("SessionComparePayload with token_usage + health + turns", async () => {
        const back = await roundtrip(SessionComparePayload, {
            task_label: null,
            sessions: [{
                session_id: "s1", source: "claude", model: null, project: null,
                started_at: null, ended_at: null, duration_ms: null,
                token_usage: {
                    model: null, prompt_tokens: null, completion_tokens: null,
                    cache_creation_input_tokens: null, cache_read_input_tokens: null,
                    estimated_tokens: 100, estimated_cost_usd: null, pricing_source: null,
                },
                health: {
                    turns: 3, tool_calls: 5, tool_errors: 0, user_corrections: 1,
                    interruptions: 0, subagent_dispatches: 2, task_label: null,
                },
                commit_count: 1, noise_score: null,
                turns: [{ seq: 0, role: "user", ts: null, gap_ms: null, est_tokens: null, est_cost_usd: null, has_error: false }],
            }],
            winners: { fastest: "s1", cheapest: null, fewest_tokens: null, cleanest: null },
            not_found: [],
        }) as { sessions: Array<{ token_usage: { estimated_tokens: number } }> };
        expect(back.sessions[0]?.token_usage.estimated_tokens).toBe(100);
    });

    test("SessionCanvasPayload node with compactions + wait_segments", async () => {
        const back = await roundtrip(SessionCanvasPayload, {
            generatedAt: "t",
            nodes: [{
                id: "s1", label: "x", project: null, source: "claude", started_at: null, ended_at: null,
                size: 1000, turns: 5, epochs: 1, compactions: [{ pre_tokens: 900, trigger: "auto" }],
                context_pressure: "low", corrections: 0, tone: "neutral", is_subagent: false,
                subagent_count: 0, wait_segments: [{ start: 0.1, end: 0.3 }],
            }],
            edges: [{ source: "s1", target: "s2", relation: "spawned", label: null }],
            warnings: [],
        }) as { nodes: Array<{ wait_segments: Array<{ end: number }> }> };
        expect(back.nodes[0]?.wait_segments[0]?.end).toBe(0.3);
    });
});
