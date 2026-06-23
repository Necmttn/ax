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

test("mineArcs drops a strict subsequence dominated by an equal-support superset", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review", "commit"]],
    ["s2", ["plan", "tdd", "review", "commit"]],
    ["s3", ["plan", "tdd", "review", "commit"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  // The 4-step superset has support=3; its 3-step sub-arc is dominated and must be dropped.
  expect(arcs.find((a) => a.steps.join(">") === "plan>tdd>review")).toBeUndefined();
  expect(arcs.find((a) => a.steps.join(">") === "plan>tdd>review>commit")).toBeDefined();
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

test("mineArcs truncates sessions longer than MAX_SESSION_SKILLS without hanging", () => {
  // Sessions of length 42 exceed the 40-skill cap; maxLen:3 keeps C(40,3)=9880
  // candidates per session so the test runs fast. Session-unique tails (x*/y*/z*)
  // ensure only the 3-skill common prefix arc survives minSessions=3.
  const tail = (prefix: string) => Array.from({ length: 39 }, (_, i) => `${prefix}${i}`);
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "commit", ...tail("x")]],
    ["s2", ["plan", "tdd", "commit", ...tail("y")]],
    ["s3", ["plan", "tdd", "commit", ...tail("z")]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 3, minSessions: 3 });
  // Truncation fires and the common prefix arc is present in results
  expect(arcs.find((a) => a.steps.join(">") === "plan>tdd>commit")).toBeDefined();
  // Session-unique tail skills can't reach minSessions=3, so no x*/y*/z* in results
  for (const arc of arcs) {
    for (const step of arc.steps) {
      expect(["plan", "tdd", "commit"].includes(step)).toBe(true);
    }
  }
});
