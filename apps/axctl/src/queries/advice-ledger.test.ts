import { describe, expect, it } from "bun:test";
import { aggregateAdviceLedger, type AdviceInput } from "./advice-ledger.ts";
import type { DispatchRow } from "./dispatch-analytics.ts";

const dispatch = (over: Partial<DispatchRow>): DispatchRow => ({
  ts: "2026-06-23T01:00:00Z",
  parent_id: "sessA",
  child_id: "child1",
  agent_type: "general-purpose",
  description: "implement the helper",
  dispatch_model: "inherit",
  child_model: "claude-opus-4-8",
  child_cost_usd: 1,
  child_legs: [],
  model_dropped: false,
  dropped_cost_usd: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_read_tokens: 0,
  cache_create_tokens: 0,
  ...over,
});

const advise = (over: Partial<AdviceInput>): AdviceInput => ({
  ts: "2026-06-23T01:00:01Z",
  parent_id: "sessA",
  description: "implement the helper",
  suggested_model: "sonnet",
  ...over,
});

describe("aggregateAdviceLedger", () => {
  it("matches advice to its dispatch by parent+description and judges follow-through", () => {
    const r = aggregateAdviceLedger(
      [advise({})],
      [dispatch({ child_model: "claude-sonnet-4-6" })],
    );
    expect(r.summary.advised).toBe(1);
    expect(r.summary.matched).toBe(1);
    expect(r.summary.followed).toBe(1);
    expect(r.summary.followThroughPct).toBe(100);
    expect(r.rows[0]!.child_model).toBe("claude-sonnet-4-6");
    expect(r.rows[0]!.followed).toBe(true);
  });

  it("counts a frontier child as not-followed", () => {
    const r = aggregateAdviceLedger([advise({})], [dispatch({ child_model: "claude-opus-4-8" })]);
    expect(r.summary.followed).toBe(0);
    expect(r.summary.notFollowed).toBe(1);
    expect(r.summary.followThroughPct).toBe(0);
  });

  it("leaves an advice with no matching dispatch unmatched (followed=null)", () => {
    const r = aggregateAdviceLedger([advise({ description: "no such dispatch" })], [dispatch({})]);
    expect(r.summary.matched).toBe(0);
    expect(r.summary.unmatched).toBe(1);
    expect(r.rows[0]!.followed).toBeNull();
    expect(r.summary.followThroughPct).toBe(0); // nothing judgeable
  });

  it("picks the nearest-ts dispatch when several share parent+description", () => {
    const r = aggregateAdviceLedger(
      [advise({ ts: "2026-06-23T05:00:00Z" })],
      [
        dispatch({ ts: "2026-06-23T01:00:00Z", child_model: "claude-opus-4-8" }),
        dispatch({ ts: "2026-06-23T05:00:30Z", child_model: "claude-sonnet-4-6" }),
      ],
    );
    expect(r.rows[0]!.child_model).toBe("claude-sonnet-4-6"); // the 05:00:30 one
    expect(r.summary.followed).toBe(1);
  });

  it("mixed batch: follow-through is followed/(followed+notFollowed)", () => {
    const r = aggregateAdviceLedger(
      [
        advise({ parent_id: "s1", description: "a" }),
        advise({ parent_id: "s2", description: "b" }),
        advise({ parent_id: "s3", description: "c" }), // unmatched
      ],
      [
        dispatch({ parent_id: "s1", description: "a", child_model: "claude-sonnet-4-6" }), // followed
        dispatch({ parent_id: "s2", description: "b", child_model: "claude-opus-4-8" }), // not
      ],
    );
    expect(r.summary).toMatchObject({ advised: 3, matched: 2, followed: 1, notFollowed: 1, unmatched: 1 });
    expect(r.summary.followThroughPct).toBe(50);
  });
});
