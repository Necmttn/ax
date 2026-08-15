import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchCostSummaryRollup, fetchPricingRows } from "./cost-summary-query.ts";
import { publishDashboardFixture, runDashboardRead } from "./testing/duckdb.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cost summary");

describe("cost summary", () => {
    dtest("reads bound rollups and pricing rows from DuckDB", async () => {
        const ts = new Date();
        const fixture = await publishDashboardFixture(tempDir("ax-cost-summary-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.putMany("session", [{ id: "s1", source: "user's harness" }, { id: "s2", source: "claude" }]);
            yield* db.putMany("session_token_usage", [
                { id: "u1", session: "s1", source: "user's harness", model: "m1", estimated_tokens: 100, transcript_bytes: 1, prompt_tokens: 70, completion_tokens: 30, estimated_cost_usd: 1.25, pricing_source: "test", ts },
                { id: "u2", session: "s2", source: "claude", model: "m2", estimated_tokens: 200, transcript_bytes: 1, prompt_tokens: null, completion_tokens: null, estimated_cost_usd: 2.5, pricing_source: null, ts },
            ]);
            yield* db.put("agent_model", { id: "am1", name: "m1", provider: "test", display_name: "Model 1", input_per_million_usd: 1, context_window: 200000, pricing_source: "fixture" });
        }));
        const rollup = await runDashboardRead(fixture, fetchCostSummaryRollup({ source: "user's harness", sinceDays: 1, limit: 20 }));
        expect(rollup.totals[0]).toMatchObject({ sessions: 1, tokens: 100, cost: 1.25 });
        expect(rollup.byModel[0]).toMatchObject({ source: "user's harness", model: "m1" });
        expect(rollup.recent[0]?.ts).toBe(ts.toISOString());
        const pricing = await runDashboardRead(fixture, fetchPricingRows());
        expect(pricing[0]).toMatchObject({ name: "m1", context_window: 200000 });
    });
});
