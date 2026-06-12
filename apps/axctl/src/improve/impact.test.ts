import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import {
    estimateImpact,
    estimateImpactCached,
    parseBaseline,
    resetImpactCacheForTest,
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

type QueryResult = Array<Record<string, unknown>>;
const makeDb = (resultsPerCall: QueryResult[][]) => {
    let call = 0;
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            const r = resultsPerCall[Math.min(call, resultsPerCall.length - 1)];
            call += 1;
            return Effect.succeed(r);
        },
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

afterEach(() => resetImpactCacheForTest());

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
            makeDb([[[]]]),
        );
        expect(est.kind).toBe("correction_pressure");
        expect(est.headline).toContain("9×");
        expect(est.detail).toContain("9 corrections across 4 sessions");
        expect(est.confidence).toBe("indicative");
    });

    test("skill: frequency + tool from baseline", async () => {
        const est = await run(
            estimateImpact(proposal({ form: "skill", baseline: '{"tool":"Bash","frequency":12}' })),
            makeDb([[[]]]),
        );
        expect(est.headline).toContain("12×");
        expect(est.headline).toContain("Bash");
    });

    test("hook with target_tool: addressable failures from tool_call stats", async () => {
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
            makeDb([[[{ n: 200 }], [{ n: 14 }]]]),
        );
        expect(est.kind).toBe("addressable_failures");
        expect(est.headline).toContain("14 failures");
        expect(est.headline).toContain("200");
        expect(est.basis).toContain("not a replay");
    });

    test("routing proposal: recomputes savings via dispatch candidates", async () => {
        // fetchDispatchCandidates issues one multi-statement query; an
        // oversized empty tuple satisfies its destructuring with zero rows.
        const est = await run(
            estimateImpact(proposal({ form: "hook", title: ROUTING_PROPOSAL_TITLE })),
            makeDb([[Array.from({ length: 8 }, () => []) as unknown as QueryResult]]),
        );
        expect(est.kind).toBe("savings_usd");
        expect(est.confidence).toBe("estimated");
        expect(est.basis).toContain("dispatch history");
    });

    test("fallback: frequency", async () => {
        const est = await run(
            estimateImpact(proposal({ form: "automation" })),
            makeDb([[[]]]),
        );
        expect(est.kind).toBe("frequency");
        expect(est.headline).toContain("7×");
    });
});

describe("estimateImpactCached", () => {
    test("second call within TTL skips recompute", async () => {
        const p = proposal({ form: "guidance", baseline: '{"frequency":3}' });
        const layer = makeDb([[[]]]);
        const a = await run(estimateImpactCached(p, 1_000), layer);
        const b = await run(estimateImpactCached(p, 2_000), layer);
        expect(b).toBe(a);
    });

    test("expired entry recomputes", async () => {
        const p = proposal({ form: "guidance", baseline: '{"frequency":3}' });
        const layer = makeDb([[[]]]);
        const a = await run(estimateImpactCached(p, 1_000), layer);
        const b = await run(estimateImpactCached(p, 1_000 + 11 * 60_000), layer);
        expect(b).not.toBe(a);
        expect(b).toEqual(a);
    });
});
