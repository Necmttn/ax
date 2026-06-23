import { expect, test } from "bun:test";
import { buildPerSession, mineArcs } from "./workflow-sequences.ts";

test("buildPerSession orders a session's skills by turn_index", () => {
  const rows = [
    { session: "s1", skill: "review", ts: "2026-06-01T03:00:00Z", turn_index: 30 },
    { session: "s1", skill: "plan", ts: "2026-06-01T01:00:00Z", turn_index: 10 },
    { session: "s1", skill: "tdd", ts: "2026-06-01T02:00:00Z", turn_index: 20 },
  ];
  expect(buildPerSession(rows).get("s1")).toEqual(["plan", "tdd", "review"]);
});

test("mineArcs finds a gapped arc recurring across >= minSessions sessions", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "recall", "tdd", "review", "commit"]],     // plan>tdd>review>commit (gapped by recall)
    ["s2", ["plan", "tdd", "review", "commit"]],
    ["s3", ["plan", "tdd", "x", "review", "commit"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  const hit = arcs.find((a) => a.steps.join(">") === "plan>tdd>review>commit");
  expect(hit).toBeDefined();
  expect(hit!.support).toBe(3);
});

test("mineArcs drops a strict subsequence covered by an equal/higher-support superset (maximality)", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review"]],
    ["s2", ["plan", "tdd", "review"]],
    ["s3", ["plan", "tdd", "review"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  // "plan>tdd" (len 2) is below minLen anyway; assert no len-3 fragment duplicates when a superset exists.
  // Here the maximal arc is plan>tdd>review itself; assert it is present exactly once.
  expect(arcs.filter((a) => a.steps.join(">") === "plan>tdd>review")).toHaveLength(1);
});

test("mineArcs drops arcs below support threshold and below minLen", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review"]],
    ["s2", ["plan", "tdd", "review"]],   // support 2 < 3
    ["s3", ["a", "b"]],                    // len 2 < 3
  ]);
  expect(mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 })).toHaveLength(0);
});

test("mineArcs counts a session at most once toward support", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review", "plan", "tdd", "review"]], // arc appears twice in one session
    ["s2", ["plan", "tdd", "review"]],
    ["s3", ["plan", "tdd", "review"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  expect(arcs.find((a) => a.steps.join(">") === "plan>tdd>review")!.support).toBe(3);
});
