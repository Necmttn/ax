import { describe, expect, test } from "bun:test";
import { computeWinners } from "./session-compare.ts";
import type { SessionCompareEntry, SessionId, SessionTokenUsageDetail } from "@ax/lib/shared/dashboard-types";

const sid = (s: string): SessionId => s as unknown as SessionId;

const usage = (over: Partial<SessionTokenUsageDetail> = {}): SessionTokenUsageDetail => ({
    model: "claude-opus-4-8",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 1_000,
    estimated_cost_usd: null,
    pricing_source: null,
    ...over,
});

const entry = (over: Partial<SessionCompareEntry> & { session_id: SessionId }): SessionCompareEntry => ({
    source: "claude",
    model: "claude-opus-4-8",
    project: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    token_usage: null,
    health: null,
    commit_count: 0,
    noise_score: null,
    ...over,
});

const A = sid("a-session");
const B = sid("b-session");

describe("computeWinners - cheapest with unknown costs (#175)", () => {
    test("no cheapest winner when any session's cost is unknown", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 209 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: null }) }),
        ]);
        // B's cost is UNKNOWN, not $0 - the priced session must not win by default.
        expect(winners.cheapest).toBeNull();
    });

    test("no cheapest winner when a session has no token usage at all", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 1.5 }) }),
            entry({ session_id: B, token_usage: null }),
        ]);
        expect(winners.cheapest).toBeNull();
    });

    test("cheapest awarded when every session has a known cost", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 3.4 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: 5.1 }) }),
        ]);
        expect(winners.cheapest).toBe(A);
    });

    test("tied costs → no cheapest winner", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 2 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: 2 }) }),
        ]);
        expect(winners.cheapest).toBeNull();
    });

    test("fewest_tokens unaffected by unknown costs", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_tokens: 100 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_tokens: 900 }) }),
        ]);
        expect(winners.fewest_tokens).toBe(A);
    });
});
