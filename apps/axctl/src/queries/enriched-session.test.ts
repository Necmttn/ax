/**
 * enriched-session.test.ts - the Enriched Session facade options matrix.
 *
 * Stubs every composed fetcher and asserts which ones run for a given options
 * combination (the performance guard - each caller issues exactly the queries
 * it asked for, nothing more) and that the assembled shape routes each result
 * into the right slot.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import type {
    SessionDetailPayload,
    SessionInsightsPayload,
    SessionViewPayload,
} from "@ax/lib/shared/dashboard-types";
import type { SessionDurabilityDetail } from "../metrics/reverted-commits.ts";
import {
    fetchEnrichedSession,
    type EnrichedSessionFetchers,
    type EnrichedSessionOptions,
} from "./enriched-session.ts";

// ---------------------------------------------------------------------------
// Stub payloads (shape-cast - the facade routes them, it does not inspect them)
// ---------------------------------------------------------------------------

const VIEW = { session: { overview: { id: "v" } } } as unknown as SessionViewPayload;
const DETAIL = { overview: { id: "d" } } as unknown as SessionDetailPayload;
const METRICS = { producedCommits: 1, revertedCommits: 0, durabilityRatio: 1, reverted: [] } as SessionDurabilityDetail;
const INSIGHTS = { phases: [] } as unknown as SessionInsightsPayload;

interface Calls {
    view: string[];
    viewTurns: Array<"excerpt" | "full" | undefined>;
    detail: string[];
    metrics: string[];
    insights: string[];
}

const makeFetchers = (): { fetchers: EnrichedSessionFetchers; calls: Calls } => {
    const calls: Calls = { view: [], viewTurns: [], detail: [], metrics: [], insights: [] };
    const fetchers: EnrichedSessionFetchers = {
        fetchView: ((opts: { sessionId: string; turns?: "excerpt" | "full" }) => {
            calls.view.push(opts.sessionId);
            calls.viewTurns.push(opts.turns);
            return Effect.succeed(VIEW);
        }) as EnrichedSessionFetchers["fetchView"],
        fetchDetail: ((id: string) => {
            calls.detail.push(id);
            return Effect.succeed(DETAIL);
        }) as EnrichedSessionFetchers["fetchDetail"],
        fetchMetrics: ((id: string) => {
            calls.metrics.push(id);
            return Effect.succeed(METRICS);
        }) as EnrichedSessionFetchers["fetchMetrics"],
        fetchInsights: ((id: string) => {
            calls.insights.push(id);
            return Effect.succeed(INSIGHTS);
        }) as EnrichedSessionFetchers["fetchInsights"],
    };
    return { fetchers, calls };
};

const run = (opts: EnrichedSessionOptions, fetchers: EnrichedSessionFetchers) =>
    Effect.runPromise(
        fetchEnrichedSession(opts, fetchers).pipe(
            // Satisfy the SurrealClient requirement; the stubs never touch it.
            Effect.provide(makeTestSurrealClient({ denyWrites: true }).layer),
        ),
    );

// ---------------------------------------------------------------------------
// Options matrix → which fetchers run
// ---------------------------------------------------------------------------

describe("fetchEnrichedSession - base selection", () => {
    it("base=view runs fetchView only, populates .view", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run(
            { sessionId: "s1", base: { kind: "view", expand: new Set(), expandAll: false, byRole: false } },
            fetchers,
        );
        expect(calls.view).toEqual(["s1"]);
        expect(calls.detail).toEqual([]);
        expect(calls.metrics).toEqual([]);
        expect(calls.insights).toEqual([]);
        expect(result.view).toBe(VIEW);
        expect(result.detail).toBeNull();
    });

    it("forwards full normalized-turn mode to the Session View", async () => {
        const { fetchers, calls } = makeFetchers();
        await run(
            {
                sessionId: "s1",
                base: {
                    kind: "view",
                    expand: new Set(),
                    expandAll: false,
                    turns: "full",
                },
            },
            fetchers,
        );

        expect(calls.viewTurns).toEqual(["full"]);
    });

    it("base=detail runs fetchDetail only, populates .detail", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run({ sessionId: "s2", base: { kind: "detail" } }, fetchers);
        expect(calls.detail).toEqual(["s2"]);
        expect(calls.view).toEqual([]);
        expect(calls.metrics).toEqual([]);
        expect(calls.insights).toEqual([]);
        expect(result.detail).toBe(DETAIL);
        expect(result.view).toBeNull();
    });
});

describe("fetchEnrichedSession - include flags gate the optional fetchers", () => {
    it("includeMetrics=false → no metrics query, .metrics null", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run({ sessionId: "s", base: { kind: "detail" } }, fetchers);
        expect(calls.metrics).toEqual([]);
        expect(result.metrics).toBeNull();
    });

    it("includeMetrics=true → one metrics query, .metrics populated", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run(
            { sessionId: "s", base: { kind: "detail" }, includeMetrics: true },
            fetchers,
        );
        expect(calls.metrics).toEqual(["s"]);
        expect(result.metrics).toBe(METRICS);
    });

    it("includeInsights=false → no insights query, .insights null", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run({ sessionId: "s", base: { kind: "detail" } }, fetchers);
        expect(calls.insights).toEqual([]);
        expect(result.insights).toBeNull();
    });

    it("includeInsights=true → one insights query, .insights populated", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run(
            { sessionId: "s", base: { kind: "detail" }, includeInsights: true },
            fetchers,
        );
        expect(calls.insights).toEqual(["s"]);
        expect(result.insights).toBe(INSIGHTS);
    });

    it("both includes on → view + metrics + insights all run exactly once", async () => {
        const { fetchers, calls } = makeFetchers();
        const result = await run(
            {
                sessionId: "s",
                base: { kind: "view", expand: new Set(), expandAll: false },
                includeMetrics: true,
                includeInsights: true,
            },
            fetchers,
        );
        expect(calls.view).toEqual(["s"]);
        expect(calls.detail).toEqual([]);
        expect(calls.metrics).toEqual(["s"]);
        expect(calls.insights).toEqual(["s"]);
        expect(result.view).toBe(VIEW);
        expect(result.metrics).toBe(METRICS);
        expect(result.insights).toBe(INSIGHTS);
    });
});

describe("fetchEnrichedSession - call-site parity", () => {
    it("CLI parity: view base, no metrics/insights folded in (probe issues view only)", async () => {
        const { fetchers, calls } = makeFetchers();
        await run(
            { sessionId: "cli", base: { kind: "view", expand: new Set(), expandAll: false, byRole: true } },
            fetchers,
        );
        // Exactly the one view query the CLI probe issued before the facade.
        expect(calls.view).toEqual(["cli"]);
        expect(calls.detail.length + calls.metrics.length + calls.insights.length).toBe(0);
    });

    it("HTTP parity: detail base, nothing else (exactly one query)", async () => {
        const { fetchers, calls } = makeFetchers();
        await run({ sessionId: "http", base: { kind: "detail" } }, fetchers);
        const total =
            calls.view.length + calls.detail.length + calls.metrics.length + calls.insights.length;
        expect(total).toBe(1);
        expect(calls.detail).toEqual(["http"]);
    });
});
