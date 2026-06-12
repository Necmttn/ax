/**
 * Tests for improve-proposals.ts
 *
 * Uses makeMockDb idiom (from skill-hygiene.test.ts) to stub SurrealClient
 * and verify that fetchImproveProposals attaches a rendered brief to each row.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchImproveProposals } from "./improve-proposals.ts";
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
        expect(brief).toContain("experiment artifact");
        expect(brief).not.toContain("ax improve accept");
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
