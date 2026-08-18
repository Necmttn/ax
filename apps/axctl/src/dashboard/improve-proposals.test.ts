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
