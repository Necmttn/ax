import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createImpactEstimateCache } from "../improve/impact.ts";
import { cacheReadTestLayer, judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import {
    createHypothesisHydrationCache,
    fetchImproveProposals,
    renderHypothesisTemplate,
} from "./improve-proposals.ts";

const proposal = (overrides: Record<string, unknown> = {}) => ({
    id: "abc", form: "skill", title: "Add skill", hypothesis: "frozen",
    dedupe_sig: "sig-open", frequency: 5, confidence: "high", status: "open",
    origin: "mined", hypothesis_template: null, evidence_query: null,
    reject_reason: null, baseline: null,
    created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
});

const env = (proposals: ReadonlyArray<Record<string, unknown>>, evidence: ReadonlyArray<Record<string, unknown>> = []) =>
    Layer.mergeAll(
        judgmentTestLayer((sql) => sql.includes("FROM proposal") ? proposals : []),
        cacheReadTestLayer(() => evidence),
    );

const deps = () => ({
    hydrationCache: createHypothesisHydrationCache(),
    impactCache: createImpactEstimateCache(),
    nowMs: () => 1_000,
});

describe("renderHypothesisTemplate", () => {
    it("fills known placeholders", () => {
        expect(renderHypothesisTemplate("{{count}} events - {{missing}}", { count: 1234 }))
            .toBe("1,234 events - {{missing}}");
    });
});

describe("fetchImproveProposals", () => {
    it("hydrates a proposal from the DuckDB cache", async () => {
        const rows = await Effect.runPromise(fetchImproveProposals(deps()).pipe(Effect.provide(env([
            proposal({ hypothesis_template: "live: {{n}}", evidence_query: "SELECT 42 AS n" }),
        ], [{ n: 42 }]))));
        expect(rows[0]?.hypothesis).toBe("live: 42");
    });

    it("attaches the open proposal brief", async () => {
        const rows = await Effect.runPromise(fetchImproveProposals(deps()).pipe(Effect.provide(env([proposal()]))));
        expect(rows[0]?.brief).toContain("sig=sig-open");
        expect(rows[0]?.brief).toContain("ax improve accept");
    });

    it("returns an empty array", async () => {
        expect(await Effect.runPromise(fetchImproveProposals(deps()).pipe(Effect.provide(env([]))))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Checkpoint DTOs - history versus current recommendation (#1134)
// ---------------------------------------------------------------------------

const measured = (overrides: Record<string, unknown> = {}) => ({
    opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
    measurement_status: "measured", measurement_version: 2,
    ...overrides,
});

const experimentRow = (overrides: Record<string, unknown> = {}) => ({
    id: "experiment-one", proposal: "abc", artifact: null,
    artifact_path: "/repo/CLAUDE.md", scaffolded_at: new Date("2026-01-10T00:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"), locked_verdict: null,
    status: "scaffolded", task_path: null,
    ...overrides,
});

const checkpointRow = (overrides: Record<string, unknown> = {}) => ({
    id: "cp-1", experiment: "experiment-one", kind: "+3s", measured: measured(),
    suggested: "adopted", user_verdict: null, observed_at: new Date("2026-01-20T00:00:00Z"),
    ...overrides,
});

const withExperiment = (
    experiment: Record<string, unknown>,
    checkpoints: ReadonlyArray<Record<string, unknown>>,
) => Layer.mergeAll(
    judgmentTestLayer((sql) =>
        sql.includes("FROM proposal") ? [proposal({ status: "accepted" })]
        : sql.includes("FROM experiment") ? [experiment]
        : sql.includes("FROM checkpoint") ? checkpoints
        : []),
    cacheReadTestLayer(() => []),
);

const experimentDto = async (
    experiment: Record<string, unknown>,
    checkpoints: ReadonlyArray<Record<string, unknown>>,
) => {
    const rows = await Effect.runPromise(
        fetchImproveProposals(deps()).pipe(Effect.provide(withExperiment(experiment, checkpoints))),
    );
    return rows[0]?.experiment;
};

describe("checkpoint DTOs", () => {
    it("preserves the optional measurement status, reason and version", async () => {
        const exp = await experimentDto(experimentRow(), [checkpointRow({
            suggested: null,
            measured: measured({
                opportunities: 0, addressed: 0, ratio: 0,
                measurement_status: "insufficient_data", reason: "no_opportunities",
            }),
        })]);
        expect(exp?.checkpoints?.[0]?.measured).toEqual({
            opportunities: 0, addressed: 0, ratio: 0, built: true,
            measurement_status: "insufficient_data", reason: "no_opportunities",
            measurement_version: 2,
        });
        // JSON null, not an absent field and not a substitute verdict string.
        expect(exp?.checkpoints?.[0]?.suggested).toBeNull();
        expect(exp?.latest_checkpoint?.suggested).toBeNull();
        expect(exp?.current_reason).toBe("no_opportunities");
    });

    it("keeps history while the current projection withholds an unsafe suggestion", async () => {
        const exp = await experimentDto(experimentRow({ status: "retired" }), [checkpointRow()]);
        expect(exp?.checkpoints?.[0]?.suggested).toBe("adopted");
        expect(exp?.latest_checkpoint?.suggested).toBeNull();
        expect(exp?.current_reason).toBe("retired");
    });

    it("passes a current measured suggestion through untouched", async () => {
        const exp = await experimentDto(experimentRow(), [checkpointRow()]);
        expect(exp?.latest_checkpoint?.suggested).toBe("adopted");
        expect(exp?.current_reason).toBeNull();
    });
});
