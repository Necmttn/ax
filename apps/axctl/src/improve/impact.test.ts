import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { makeTestCacheRead, type TestCacheOptions } from "@ax/lib/testing/cache";
import type { CacheRead } from "@ax/lib/duckdb/seam";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import {
    createImpactEstimateCache,
    estimateImpact,
    estimateImpactCached,
    parseBaseline,
    ROUTING_PROPOSAL_TITLE,
} from "./impact.ts";

const proposal = (over: Partial<ProposalDto>): ProposalDto =>
    ({
        id: "proposal:t",
        form: "guidance",
        title: "t",
        hypothesis: "h",
        dedupe_sig: "sig-t",
        frequency: 7,
        confidence: "medium",
        status: "open",
        reject_reason: null,
        created_at: "2026-06-01T00:00:00Z",
        ...over,
    }) as ProposalDto;

/** A real-decode CacheRead fake (@ax/lib/testing/cache) - empty routes ->
 *  every query returns zero rows, which is enough for the estimators that
 *  never touch CacheRead (guidance/skill/fallback) and a valid zero baseline
 *  for the ones that do (hook, routing). */
const cacheRead = (routes: TestCacheOptions["routes"] = {}) => makeTestCacheRead({ routes });

const run = <A>(eff: Effect.Effect<A, unknown, CacheRead>, layer: Layer.Layer<CacheRead>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("parseBaseline", () => {
    test("tolerates missing/corrupt baseline", () => {
        expect(parseBaseline(proposal({}))).toEqual({});
        expect(parseBaseline(proposal({ baseline: "not json" }))).toEqual({});
        expect(parseBaseline(proposal({ baseline: '{"frequency":3}' }))).toEqual({ frequency: 3 });
    });
});

describe("estimateImpact", () => {
    test("guidance: correction pressure from baseline evidence", async () => {
        const est = await run(
            estimateImpact(proposal({
                form: "guidance",
                baseline: '{"frequency":9,"evidence":"9 corrections across 4 sessions"}',
            })),
            cacheRead().layer,
        );
        expect(est.kind).toBe("correction_pressure");
        // headline = LIVE frequency (matches the card chip); frozen baseline (9) becomes a growth note
        expect(est.headline).toContain("7×");
        expect(est.detail).toContain("9 corrections across 4 sessions");
        expect(est.detail).toContain("was 9x when first proposed");
        expect(est.confidence).toBe("indicative");
    });

    test("skill: frequency + tool from baseline", async () => {
        const est = await run(
            estimateImpact(proposal({ form: "skill", baseline: '{"tool":"Bash","frequency":12}' })),
            cacheRead().layer,
        );
        // live frequency (7 on the fixture), not the frozen baseline 12
        expect(est.headline).toContain("7×");
        expect(est.headline).toContain("Bash");
        expect(est.detail).toContain("was 12x when first proposed");
    });

    test("hook with target_tool: addressable failures from tool_call stats", async () => {
        // Two `tool_call` count(*) queries hit the same table: the total and
        // the `status = ?` failure count. Distinguish by SQL shape, exactly
        // as the real DuckDB statements differ.
        const est = await run(
            estimateImpact(proposal({
                form: "hook",
                hook_payload: {
                    event_name: "PreToolUse",
                    target_tool: "Bash",
                    hook_command: "x",
                    recovery_path: null,
                    smoke_test_command: null,
                    disable_command: null,
                    failure_mode: null,
                },
            } as Partial<ProposalDto>)),
            cacheRead({
                "FROM tool_call": (sql) => sql.includes("status = ?") ? [{ n: 14 }] : [{ n: 200 }],
            }).layer,
        );
        expect(est.kind).toBe("addressable_failures");
        expect(est.headline).toContain("14 failures");
        expect(est.headline).toContain("200");
        expect(est.basis).toContain("not a replay");
    });

    test("routing proposal: recomputes savings via dispatch candidates", async () => {
        // fetchDispatchCandidates is CacheRead-native; empty routes -> zero
        // rows everywhere, which is a valid (empty) baseline.
        const est = await run(
            estimateImpact(proposal({ form: "hook", title: ROUTING_PROPOSAL_TITLE })),
            cacheRead().layer,
        );
        expect(est.kind).toBe("savings_usd");
        expect(est.confidence).toBe("estimated");
        expect(est.basis).toContain("dispatch history");
    });

    test("fallback: frequency", async () => {
        const est = await run(
            estimateImpact(proposal({ form: "automation" })),
            cacheRead().layer,
        );
        expect(est.kind).toBe("frequency");
        expect(est.headline).toContain("7×");
    });
});

describe("estimateImpactCached", () => {
    test("second call within TTL skips recompute", async () => {
        const p = proposal({ form: "guidance", baseline: '{"frequency":3}' });
        const layer = makeDb([[[]]]);
        const cache = createImpactEstimateCache();
        const a = await run(estimateImpactCached(p, 1_000, cache), layer);
        const b = await run(estimateImpactCached(p, 2_000, cache), layer);
        expect(b).toBe(a);
    });

    test("expired entry recomputes", async () => {
        const p = proposal({ form: "guidance", baseline: '{"frequency":3}' });
        const layer = makeDb([[[]]]);
        const cache = createImpactEstimateCache();
        const a = await run(estimateImpactCached(p, 1_000, cache), layer);
        const b = await run(estimateImpactCached(p, 1_000 + 11 * 60_000, cache), layer);
        expect(b).not.toBe(a);
        expect(b).toEqual(a);
    });

    test("independent cache adapters isolate same-sig estimates", async () => {
        const p = proposal({ form: "guidance", baseline: '{"frequency":3}' });
        const layer = makeDb([[[]]]);
        const a = await run(estimateImpactCached(p, 1_000, createImpactEstimateCache()), layer);
        const b = await run(estimateImpactCached(p, 2_000, createImpactEstimateCache()), layer);
        expect(b).not.toBe(a);
        expect(b).toEqual(a);
    });
});
