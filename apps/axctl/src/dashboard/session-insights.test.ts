import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { _resetBaselineCacheForTests } from "./session-baselines.ts";
import { fetchSessionInsights } from "./session-insights.ts";

const BARE = "aaaaaaaa-0000-0000-0000-000000000001";
const CHILD = "bbbbbbbb-0000-0000-0000-000000000002";

const run = (stub: SurrealClientShape) =>
    Effect.runPromise(
        fetchSessionInsights(BARE).pipe(Effect.provideService(SurrealClient, stub)),
    );

const emptyPrimaryResponse = [[], [], [], [], [], [], [], [], []];
const emptyBaselineResponse = [[], [], [], []];

beforeEach(() => {
    _resetBaselineCacheForTests();
});

describe("fetchSessionInsights", () => {
    test("assembles full payload and groups diagnostic checks", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                [
                    [{ phase: "plan", start_ts: "2026-06-11T01:00:00Z", end_ts: "2026-06-11T01:12:00Z", duration_ms: 720000 }],
                    [{ ts: "2026-06-11T01:20:00Z", reaction_type: "correction" }],
                    [
                        { ts: "2026-06-11T01:30:00Z", sha: "def456", reverted: false },
                        { ts: "2026-06-11T01:25:00Z", sha: "abc123", reverted: true },
                        { ts: "2026-06-11T01:35:00Z", sha: null, reverted: false },
                    ],
                    [{ id: `session:\`${CHILD}\``, started_at: "2026-06-11T01:05:00Z", ended_at: "2026-06-11T01:15:00Z" }],
                    [
                        { kind: "test", status: "fail", ts: "2026-06-11T01:21:00Z" },
                        { kind: "test", status: "pass", ts: "2026-06-11T01:25:00Z" },
                        { kind: "lint", status: "error", ts: "2026-06-11T01:26:00Z" },
                    ],
                    [
                        { skill: "skill:`superpowers__test-driven-development`", ts: "2026-06-11T01:02:00Z" },
                        { skill: "skill:`github__yeet`", ts: "2026-06-11T01:04:00Z" },
                    ],
                    [{ lines_added: 2100, lines_removed: 940, durability_ratio: 0.8, delegation_ratio: 0.38, time_to_land_ms: 200 }],
                    [{ estimated_cost_usd: 11.2, context_window: 200000, cache_read_input_tokens: 100, estimated_tokens: 350, prompt_tokens: 50 }],
                    [{ user_corrections: 2, tool_errors: 5 }],
                ],
                [[
                    { seq: 1, prompt_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ts: "2026-06-11T01:01:00Z" },
                    { seq: 2, prompt_tokens: 4000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, ts: "2026-06-11T01:06:00Z" },
                ]],
                [[{ ts: "2026-06-11T01:40:00Z" }]],
                [
                    [{ estimated_cost_usd: 5.6 }],
                    [{ friction: 7 }],
                    [{ time_to_land_ms: 400 }],
                    [{ estimated_tokens: 1000, turns: 10 }],
                ],
            ],
        });

        const payload = await run(tc.client);

        expect(payload).toMatchObject({
            session: BARE,
            phases: [{ phase: "plan", start_ts: "2026-06-11T01:00:00Z", end_ts: "2026-06-11T01:12:00Z", duration_ms: 720000 }],
            friction_ticks: [{ ts: "2026-06-11T01:20:00Z", kind: "correction" }],
            subagent_spans: [{ id: CHILD, started_at: "2026-06-11T01:05:00Z", ended_at: "2026-06-11T01:15:00Z" }],
            loc: { added: 2100, removed: 940 },
            durability: 0.8,
            delegation_ratio: 0.38,
            compactions: [{ ts: "2026-06-11T01:40:00Z" }],
        });
        expect(payload.commits).toEqual([
            { ts: "2026-06-11T01:25:00Z", sha: "abc123", reverted: true },
            { ts: "2026-06-11T01:30:00Z", sha: "def456", reverted: false },
        ]);
        expect(payload.checks).toEqual([
            { kind: "test", runs: [{ ts: "2026-06-11T01:21:00Z", ok: false }, { ts: "2026-06-11T01:25:00Z", ok: true }] },
            { kind: "lint", runs: [{ ts: "2026-06-11T01:26:00Z", ok: false }] },
        ]);
        expect(payload.skills).toEqual([
            { name: "superpowers:test-driven-development", ts: "2026-06-11T01:02:00Z" },
            { name: "github:yeet", ts: "2026-06-11T01:04:00Z" },
        ]);
        expect(payload.context_curve).toEqual([
            { t: 0, pct: 0.005 },
            { t: 300000, pct: 0.0275 },
        ]);
        expect(payload.baseline).toEqual({
            cost_ratio: 2,
            friction_ratio: 1,
            land_ratio: 0.5,
            cache_pct: 100 / 350,
        });
    });

    test("empty session returns empty sections and null ratios", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                emptyPrimaryResponse,
                [[]],
                [[]],
                emptyBaselineResponse,
            ],
        });

        const payload = await run(tc.client);

        expect(payload.session).toBe(BARE);
        expect(payload.phases).toEqual([]);
        expect(payload.friction_ticks).toEqual([]);
        expect(payload.commits).toEqual([]);
        expect(payload.subagent_spans).toEqual([]);
        expect(payload.checks).toEqual([]);
        expect(payload.loc).toBeNull();
        expect(payload.durability).toBeNull();
        expect(payload.delegation_ratio).toBeNull();
        expect(payload.skills).toEqual([]);
        expect(payload.context_curve).toEqual([]);
        expect(payload.compactions).toEqual([]);
        expect(payload.baseline).toEqual({
            cost_ratio: null,
            friction_ratio: null,
            land_ratio: null,
            cache_pct: null,
        });
    });

    test("first query is session-scoped and turn_token_usage only appears in second query", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                emptyPrimaryResponse,
                [[]],
                [[]],
                emptyBaselineResponse,
            ],
        });

        await run(tc.client);

        expect(tc.captured).toHaveLength(4);
        const first = tc.captured[0]!;
        const second = tc.captured[1]!;
        expect(first).toContain("FROM phase_span WHERE session =");
        expect(first).toContain("FROM reaction_event WHERE session =");
        expect(first).toContain("FROM produced WHERE in =");
        expect(first).toContain("FROM spawned WHERE in =");
        expect(first).toContain("FROM diagnostic_event WHERE session =");
        expect(first).toContain("FROM invoked WHERE session =");
        expect(first).toContain("FROM session_metrics WHERE session =");
        expect(first).toContain("FROM session_token_usage WHERE session =");
        expect(first).toContain("FROM session_health WHERE session =");
        expect(first).not.toMatch(/FROM turn\b/);
        expect(first).not.toContain("turn_token_usage");
        expect(second).toContain("FROM turn_token_usage WHERE session =");
        expect(tc.captured.slice(2).join("\n")).not.toContain("turn_token_usage");
    });

    test("baseline failure degrades ratios to null while returning the payload", async () => {
        const failingBaseline = Effect.fail(new Error("baseline unavailable") as DbError);
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                [
                    [], [], [], [], [],
                    [],
                    [{ lines_added: 10, lines_removed: 4, durability_ratio: 0.5, delegation_ratio: 0.25, time_to_land_ms: 100 }],
                    [{ estimated_cost_usd: 8, context_window: 200000, cache_read_input_tokens: 50, estimated_tokens: 100, prompt_tokens: 50 }],
                    [{ user_corrections: 1, tool_errors: 1 }],
                ],
                [[]],
                [[]],
                failingBaseline,
            ],
        });

        const payload = await run(tc.client);

        expect(payload.loc).toEqual({ added: 10, removed: 4 });
        expect(payload.baseline).toEqual({
            cost_ratio: null,
            friction_ratio: null,
            land_ratio: null,
            cache_pct: 0.5,
        });
    });

    test("resetting baselines cache forces a fresh baseline query", async () => {
        const primaryWithCost = [
            [], [], [], [], [], [],
            [{ lines_added: 1, lines_removed: 0, durability_ratio: null, delegation_ratio: null, time_to_land_ms: 100 }],
            [{ estimated_cost_usd: 10, context_window: 200000, cache_read_input_tokens: 0, estimated_tokens: 100, prompt_tokens: 50 }],
            [{ user_corrections: 1, tool_errors: 0 }],
        ];
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                primaryWithCost,
                [[]],
                [[]],
                [[{ estimated_cost_usd: 10 }], [{ friction: 1 }], [{ time_to_land_ms: 100 }], []],
                primaryWithCost,
                [[]],
                [[]],
                [[{ estimated_cost_usd: 5 }], [{ friction: 1 }], [{ time_to_land_ms: 100 }], []],
            ],
        });

        const first = await run(tc.client);
        _resetBaselineCacheForTests();
        const second = await run(tc.client);

        expect(first.baseline.cost_ratio).toBe(1);
        expect(second.baseline.cost_ratio).toBe(2);
        expect(tc.captured).toHaveLength(8);
    });
});
