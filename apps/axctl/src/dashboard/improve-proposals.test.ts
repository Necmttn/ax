/**
 * Tests for improve-proposals.ts
 *
 * Uses makeMockDb idiom (from skill-hygiene.test.ts) to stub SurrealClient
 * and verify that fetchImproveProposals attaches a rendered brief to each row.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { resetImpactCacheForTest } from "../improve/impact.ts";
import { fetchImproveProposals, renderHypothesisTemplate, resetHydrateCacheForTest } from "./improve-proposals.ts";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

type QueryResult = Array<unknown>;

const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            return Effect.succeed(results as unknown as [QueryResult, ...QueryResult[]]);
        },
        // biome-ignore lint: other methods not needed
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
) => Effect.runPromise(eff.pipe(Effect.provide(layer)));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openRow: Record<string, unknown> = {
    id: "proposal:abc",
    form: "skill",
    title: "Add composto skill",
    hypothesis: "composto reduces context reads by 30%",
    dedupe_sig: "sig-open-001",
    frequency: 5,
    confidence: "high",
    status: "open",
    reject_reason: null,
    created_at: "2026-01-01T00:00:00Z",
};

const acceptedRow: Record<string, unknown> = {
    id: "proposal:def",
    form: "guidance",
    title: "Update CLAUDE.md guidance",
    hypothesis: "clearer guidance reduces retries",
    dedupe_sig: "sig-accepted-002",
    frequency: 3,
    confidence: "medium",
    status: "accepted",
    reject_reason: null,
    created_at: "2026-01-02T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderHypothesisTemplate", () => {
    it("fills placeholders, formats numbers, leaves unknown keys literal", () => {
        expect(
            renderHypothesisTemplate("{{count}} dispatches; est ${{savings}} - {{missing}}", {
                count: 1234,
                savings: "209.59",
            }),
        ).toBe("1,234 dispatches; est $209.59 - {{missing}}");
    });
});

/** Call-sequenced mock: nth query gets nth result set. */
const makeSequencedDb = (perCall: QueryResult[][]): Layer.Layer<SurrealClient> => {
    let call = 0;
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            const r = perCall[Math.min(call, perCall.length - 1)];
            call += 1;
            return Effect.succeed(r as unknown as [QueryResult, ...QueryResult[]]);
        },
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

describe("fetchImproveProposals - hypothesis hydration", () => {
    it("hydrates from evidence_query first row", async () => {
        resetHydrateCacheForTest();
        const dynamicRow = {
            ...openRow,
            dedupe_sig: "sig-dyn",
            hypothesis: "frozen: 11 occurrences",
            hypothesis_template: "live: {{n}} occurrences",
            evidence_query: "SELECT count() AS n FROM tool_call GROUP ALL;",
        };
        const rows = await run(
            fetchImproveProposals(),
            // call 1: proposals list; call 2: the evidence query
            makeSequencedDb([[[dynamicRow]], [[{ n: 42 }]]]),
        ) as ReadonlyArray<ProposalDto>;
        expect(rows[0]?.hypothesis).toBe("live: 42 occurrences");
    });

    it("mined routing proposal: hypothesis rebuilt from the live impact estimate", async () => {
        resetHydrateCacheForTest();
        resetImpactCacheForTest();
        const routingRow = {
            ...openRow,
            form: "hook",
            title: "Route mechanical subagent dispatches to cheaper models",
            dedupe_sig: "sig-routing",
            hypothesis:
                "39 model-less dispatches on fable/opus matched mechanical routing classes in the last 2d; est $209.59 redirectable. Apply: ax dispatches compile-routing + route-dispatch hook (ax hooks install).",
        };
        const rows = await run(
            fetchImproveProposals(),
            // call 1: proposals list; call 2: fetchDispatchCandidates multi-statement
            // (oversized empty tuple satisfies its destructuring with zero rows)
            makeSequencedDb([[[routingRow]], Array.from({ length: 8 }, () => []) as QueryResult[]]),
        ) as ReadonlyArray<ProposalDto>;
        const h = rows[0]!.hypothesis;
        // live figure (here $0.00 - empty candidates) replaces the frozen $209.59
        expect(h).not.toContain("$209.59");
        expect(h).toContain("est $0.00 redirectable over 30d");
        // chip regex in next-actions reads "est $..." - keep that shape
        expect(/est \$[\d,]+(?:\.\d+)?/.test(h)).toBe(true);
        // the action tail survives hydration
        expect(h).toContain("Apply: ax dispatches compile-routing");
    });

    it("fail-open: non-readonly or failing query keeps the frozen hypothesis", async () => {
        resetHydrateCacheForTest();
        const badRow = {
            ...openRow,
            dedupe_sig: "sig-bad",
            hypothesis: "frozen stays",
            hypothesis_template: "live: {{n}}",
            evidence_query: "DELETE proposal;",
        };
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[badRow]]),
        ) as ReadonlyArray<ProposalDto>;
        expect(rows[0]?.hypothesis).toBe("frozen stays");
    });
});

describe("fetchImproveProposals - brief attachment", () => {
    it("open row: brief contains sig and open-status ask", async () => {
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[openRow]]),
        ) as ReadonlyArray<ProposalDto>;

        expect(rows).toHaveLength(1);
        const { brief } = rows[0];
        expect(brief).toBeTypeOf("string");
        expect(brief).toContain("sig=sig-open-001");
        expect(brief).toContain("ax improve accept");
    });

    it("non-open row: brief contains sig and experiment-status ask", async () => {
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[acceptedRow]]),
        ) as ReadonlyArray<ProposalDto>;

        expect(rows).toHaveLength(1);
        const { brief } = rows[0];
        expect(brief).toBeTypeOf("string");
        expect(brief).toContain("sig=sig-accepted-002");
        expect(brief).toContain("lock a verdict");
        expect(brief).not.toContain("ax improve accept");
    });

    it("coalesces missing origin to mined; preserves explicit agent", async () => {
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[openRow, { ...openRow, dedupe_sig: "sig-agent", origin: "agent" }]]),
        ) as ReadonlyArray<ProposalDto>;

        expect(rows[0]?.origin).toBe("mined");
        expect(rows[1]?.origin).toBe("agent");
    });

    it("returns empty array for empty DB result", async () => {
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[]]),
        );
        expect(rows).toEqual([]);
    });

    it("attaches brief to every row in a multi-row result", async () => {
        const rows = await run(
            fetchImproveProposals(),
            makeMockDb([[openRow, acceptedRow]]),
        ) as ReadonlyArray<ProposalDto>;

        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.brief).toBeTypeOf("string");
            expect(row.brief!.length).toBeGreaterThan(0);
        }
    });
});
