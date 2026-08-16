/**
 * `fetchAdviceLedger` against a REAL published DuckDB snapshot.
 *
 * This file exists because of a defect a stub or a SQL-text assertion cannot
 * see. `fetchAdviceLedger` was HALF-ported: the dispatch half read the DuckDB
 * cache through `CacheRead`, while the advice half still ran SurrealQL against
 * SurrealDB - which nothing has written since `advice` became a live DuckDB
 * table. An empty table is not an error, so `ax dispatches --advice` and the
 * `dispatches_advice` MCP tool returned an EMPTY ledger with a clean exit: a
 * wrong answer, not a failure.
 *
 * Two more traps are pinned here, both invisible to a mocked seam:
 *
 *  1. The day bound must be {@link daysAgoExpr}. The obvious spelling
 *     (`CURRENT_TIMESTAMP - INTERVAL`) does not BIND at all against the static
 *     DuckDB build ax ships, because TIMESTAMPTZ arithmetic needs ICU.
 *  2. The window must actually FILTER. A predicate that matches everything and
 *     a predicate that is correct are indistinguishable from a fixture whose
 *     rows all sit inside the window, so one advise row is seeded 60 days back
 *     and the same read is run at two different widths.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchAdviceLedger } from "./advice-ledger.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("advice ledger", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

/** Session ids in the shape the cache actually stores: BARE, no `session:`. */
const PARENT = "019e2531-b552-7b53-a029-c780adbb6560";
const CHILD = "019e2531-ffff-7b53-a029-c780adbb6561";

const ROUTED_DESC = "gather references for the pricing lens";
const ORPHAN_DESC = "advised but never dispatched";

const adviceRow = (
    id: string,
    ts: Date,
    description: string,
    verdict: string,
    suggestedModel: string | null,
) => ({
    id,
    ts,
    session: PARENT,
    tool: "Agent",
    description,
    verdict,
    advice_text: "consider routing this to sonnet",
    suggested_model: suggestedModel,
});

describe("fetchAdviceLedger over a published snapshot", () => {
    dtest("joins DuckDB advice rows to their dispatch outcome", async () => {
        const dir = tempDir("advice-ledger");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // (1) advised AND dispatched - the joined row.
                    yield* write.put("advice", adviceRow("advice:1", hoursAgo(2), ROUTED_DESC, "advise", "sonnet"));
                    // (2) advised, never dispatched - stays unmatched.
                    yield* write.put("advice", adviceRow("advice:2", hoursAgo(3), ORPHAN_DESC, "advise", "haiku"));
                    // (3) OUTSIDE the 7-day window - proves the bound filters.
                    yield* write.put("advice", adviceRow("advice:old", daysAgo(60), ROUTED_DESC, "advise", "sonnet"));
                    // (4) a plain allow fire - the verdict filter must drop it.
                    yield* write.put("advice", adviceRow("advice:allow", hoursAgo(1), ROUTED_DESC, "allow", null));

                    // The dispatch advice (1) is joined to: same parent session,
                    // same description.
                    yield* write.put("spawned", {
                        id: "spawned:1",
                        in_id: PARENT,
                        out_id: CHILD,
                        ts: hoursAgo(2),
                        tool: "Task",
                        agent_type: "general-purpose",
                        description: ROUTED_DESC,
                        tool_use_id: null,
                    });

                    // The child's own usage row is where child_model comes from.
                    yield* write.put("session_token_usage", {
                        id: "stu:1",
                        session: CHILD,
                        source: "claude-subagent",
                        model: "claude-sonnet-4-6",
                        prompt_tokens: 1000n,
                        completion_tokens: 200n,
                        cache_read_input_tokens: 0n,
                        cache_creation_input_tokens: 0n,
                        estimated_tokens: 1200n,
                        transcript_bytes: 4096n,
                        estimated_cost_usd: 1.23,
                        ts: hoursAgo(2),
                    });
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            Effect.all({
                week: fetchAdviceLedger({ sinceDays: 7, limit: 30 }),
                quarter: fetchAdviceLedger({ sinceDays: 90, limit: 30 }),
            }).pipe(Effect.provide(layer)),
        );

        // The ledger is NOT empty - the whole point. Two advise rows are in the
        // 7-day window; the 60-day-old one and the `allow` fire are excluded.
        expect(result.week.summary.advised).toBe(2);
        expect(result.week.rows).toHaveLength(2);

        // The join actually happened: one advise resolved to the child's model.
        expect(result.week.summary.matched).toBe(1);
        expect(result.week.summary.unmatched).toBe(1);

        const joined = result.week.rows.find((row) => row.description === ROUTED_DESC);
        expect(joined).toBeDefined();
        expect(joined!.parent_id).toBe(PARENT);
        expect(joined!.suggested_model).toBe("sonnet");
        expect(joined!.child_model).toBe("claude-sonnet-4-6");
        // Advised sonnet, child ran sonnet - honored.
        expect(joined!.followed).toBe(true);
        expect(result.week.summary.followed).toBe(1);
        expect(result.week.summary.followThroughPct).toBe(100);
        // `ts` is rendered as an ISO string; `ax dispatches --advice` slices it.
        expect(joined!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        const orphan = result.week.rows.find((row) => row.description === ORPHAN_DESC);
        expect(orphan).toBeDefined();
        expect(orphan!.child_model).toBeNull();
        expect(orphan!.followed).toBeNull();

        // Widening the window pulls the 60-day-old advise back in. If the day
        // bound matched everything, both reads would report the same count -
        // so this is what proves the predicate is load-bearing.
        expect(result.quarter.summary.advised).toBe(3);
    });
});
