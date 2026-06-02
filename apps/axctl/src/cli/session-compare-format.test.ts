import { describe, expect, test } from "bun:test";
import { renderCompareJson, renderCompareTable } from "./session-compare-format.ts";
import type {
    SessionCompareEntry,
    SessionComparePayload,
    SessionId,
} from "@ax/lib/shared/dashboard-types";

const sid = (s: string): SessionId => s as unknown as SessionId;

const entry = (over: Partial<SessionCompareEntry> & { session_id: SessionId }): SessionCompareEntry => ({
    source: "claude",
    model: "opus-4.8",
    project: "ax",
    started_at: "2026-06-01T10:00:00.000Z",
    ended_at: "2026-06-01T10:10:00.000Z",
    duration_ms: 600_000,
    token_usage: null,
    health: null,
    commit_count: 0,
    noise_score: null,
    ...over,
});

const A = sid("019e0ad4-c977-7ab8-0000-00000000000a");
const B = sid("019e0ad4-c977-7ab8-0000-00000000000b");

const payload = (): SessionComparePayload => ({
    task_label: "wire up compare view",
    sessions: [
        entry({
            session_id: A,
            duration_ms: 600_000, // 10m - faster
            token_usage: {
                model: "opus-4.8",
                prompt_tokens: null,
                completion_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                estimated_tokens: 1_200_000,
                estimated_cost_usd: 3.4,
                pricing_source: "table",
            },
            health: {
                turns: 42,
                tool_calls: 88,
                tool_errors: 2,
                user_corrections: 1,
                interruptions: 0,
                subagent_dispatches: 3,
                task_label: "wire up compare view",
            },
            commit_count: 4,
            noise_score: 3,
        }),
        entry({
            session_id: B,
            source: "codex",
            model: "gpt-5",
            duration_ms: 1_082_000, // 18m02s - slower
            token_usage: {
                model: "gpt-5",
                prompt_tokens: null,
                completion_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                estimated_tokens: 2_000_000,
                estimated_cost_usd: 5.1,
                pricing_source: "table",
            },
            health: {
                turns: 51,
                tool_calls: 120,
                tool_errors: 7,
                user_corrections: 3,
                interruptions: 1,
                subagent_dispatches: 0,
                task_label: "wire up compare view",
            },
            commit_count: 2,
            noise_score: 11,
        }),
    ],
    winners: { fastest: A, cheapest: A, fewest_tokens: A, cleanest: A },
    not_found: [],
});

describe("renderCompareTable", () => {
    test("renders header with session count and shared task label", () => {
        const out = renderCompareTable(payload());
        expect(out).toContain("Comparing 2 sessions");
        expect(out).toContain("task: wire up compare view");
    });

    test("renders all metric rows", () => {
        const out = renderCompareTable(payload());
        for (const label of [
            "source",
            "model",
            "duration",
            "turns",
            "tokens",
            "cost",
            "tool calls",
            "tool errors",
            "corrections",
            "interruptions",
            "noise (err+corr+int)",
            "commits",
        ]) {
            expect(out).toContain(label);
        }
    });

    test("stars the winning cell on ranked rows", () => {
        const out = renderCompareTable(payload());
        const lines = out.split("\n");
        // session A is the winner on duration/cost/tokens/noise → those rows
        // carry a single star, in A's column (the first data column).
        const durationLine = lines.find((l) => l.startsWith("duration"))!;
        expect(durationLine).toContain("*");
        const noiseLine = lines.find((l) => l.startsWith("noise"))!;
        expect(noiseLine).toContain("3 *");
    });

    test("formats duration / tokens / cost compactly", () => {
        const out = renderCompareTable(payload());
        expect(out).toContain("10m 00s");
        expect(out).toContain("18m 02s");
        expect(out).toContain("1.2M");
        expect(out).toContain("2.0M");
        expect(out).toContain("$3.40");
        expect(out).toContain("$5.10");
    });

    test("renders a lane legend mapping [n] to full session ids", () => {
        const out = renderCompareTable(payload());
        expect(out).toContain(`[1] ${A}`);
        expect(out).toContain(`[2] ${B}`);
    });

    test("summarizes winners line by lane tag", () => {
        const out = renderCompareTable(payload());
        expect(out).toContain("Winners:");
        // session A is lane [1] and wins every ranked axis.
        expect(out).toContain("fastest [1]");
        expect(out).toContain("cleanest [1]");
    });

    test("mixed task labels render as (mixed)", () => {
        const p = payload();
        const mixed: SessionComparePayload = { ...p, task_label: null };
        expect(renderCompareTable(mixed)).toContain("(mixed / unlabeled)");
    });

    test("missing health/usage degrade to em dash, no winner star", () => {
        const bare: SessionComparePayload = {
            task_label: null,
            sessions: [
                entry({ session_id: A, token_usage: null, health: null, noise_score: null }),
                entry({ session_id: B, token_usage: null, health: null, noise_score: null }),
            ],
            winners: { fastest: null, cheapest: null, fewest_tokens: null, cleanest: null },
            not_found: [],
        };
        const out = renderCompareTable(bare);
        expect(out).toContain("-");
        expect(out).toContain("Winners: (no clear winner)");
    });

    test("lists not-found ids", () => {
        const p = payload();
        const withMissing: SessionComparePayload = { ...p, not_found: ["bogus-id"] };
        expect(renderCompareTable(withMissing)).toContain("Not found: bogus-id");
    });
});

describe("renderCompareTable --turns appendix", () => {
    const withTurns = (): SessionComparePayload => {
        const p = payload();
        return {
            ...p,
            sessions: [
                {
                    ...p.sessions[0]!,
                    turns: [
                        { seq: 0, role: "user", ts: "2026-06-01T10:00:00.000Z", gap_ms: null, est_tokens: null, est_cost_usd: null, has_error: false },
                        { seq: 1, role: "assistant", ts: "2026-06-01T10:00:08.000Z", gap_ms: 8_000, est_tokens: 12_300, est_cost_usd: 0.04, has_error: true },
                    ],
                },
                {
                    ...p.sessions[1]!,
                    turns: [
                        { seq: 0, role: "user", ts: "2026-06-01T10:00:00.000Z", gap_ms: null, est_tokens: null, est_cost_usd: null, has_error: false },
                    ],
                },
            ],
        };
    };

    test("renders a per-turn block with lane headers", () => {
        const out = renderCompareTable(withTurns());
        expect(out).toContain("Per-turn");
        expect(out).toContain("turn");
    });

    test("flags error turns and shows gap", () => {
        const out = renderCompareTable(withTurns());
        expect(out).toContain("12.3k 8s !");
    });

    test("pads ragged lanes (session [2] has fewer turns)", () => {
        const out = renderCompareTable(withTurns());
        const lines = out.split("\n");
        // 2 turn rows exist even though session [2] has only 1 turn.
        const turnRows = lines.filter((l) => /^\d+ /.test(l));
        expect(turnRows.length).toBe(2);
    });

    test("no per-turn block when turns absent", () => {
        expect(renderCompareTable(payload())).not.toContain("Per-turn");
    });
});

describe("renderCompareJson", () => {
    test("round-trips the payload", () => {
        const p = payload();
        const parsed = JSON.parse(renderCompareJson(p));
        expect(parsed.sessions.length).toBe(2);
        expect(parsed.winners.fastest).toBe(A);
        expect(parsed.task_label).toBe("wire up compare view");
    });
});
