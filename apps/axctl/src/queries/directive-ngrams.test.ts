import { expect, test } from "bun:test";
import { computeLift, tallyNgramOutcomes } from "./directive-ngrams.ts";

test("lift ranks outcome-leading ngrams above filler", () => {
  const rows = [
    { ngram: "remember to", n: 2, occurrences: 10, outcomes: 8, sessions: 6 },
    { ngram: "can you",     n: 2, occurrences: 40, outcomes: 4, sessions: 20 },
  ];
  const out = computeLift(rows, 0.1, { minOccurrences: 5, minSessions: 3 });
  expect(out.find((r) => r.ngram === "remember to")!.lift).toBeCloseTo(8.0, 1); // (8/10)/0.1
  expect(out.find((r) => r.ngram === "can you")!.lift).toBeCloseTo(1.0, 1);     // (4/40)/0.1
  expect(out[0].ngram).toBe("remember to"); // sorted desc by lift
});

test("sparsity guard drops ngrams below thresholds", () => {
  const rows = [{ ngram: "one off", n: 2, occurrences: 2, outcomes: 2, sessions: 1 }];
  expect(computeLift(rows, 0.1, { minOccurrences: 5, minSessions: 3 })).toHaveLength(0);
});

test("baseRate of zero yields zero lift, never NaN/Infinity", () => {
  const rows = [{ ngram: "x y", n: 2, occurrences: 5, outcomes: 0, sessions: 3 }];
  expect(computeLift(rows, 0, { minOccurrences: 5, minSessions: 3 })[0].lift).toBe(0);
});

test("tallyNgramOutcomes credits ngrams whose turn precedes an in-window same-session outcome", () => {
  const turns = [
    { id: "t1", sid: "sA", seq: 1, ts: "2026-06-01T00:00:00Z", text_excerpt: "remember to dogfood before showing me" },
    { id: "t2", sid: "sA", seq: 50, ts: "2026-06-01T05:00:00Z", text_excerpt: "remember to dogfood before showing me" }, // outcome ts before this turn - out of window
    { id: "t3", sid: "sB", seq: 1, ts: "2026-06-02T00:00:00Z", text_excerpt: "can you explain this" },
  ];
  const outcomes = [
    { sid: "sA", ts: "2026-06-01T00:30:00Z" }, // after t1 (in window), before t2 (t2 has no outcome)
  ];
  const rows = tallyNgramOutcomes(turns, outcomes, { windowTurns: 20 });
  const dogfood = rows.find((r) => r.ngram === "remember dogfood" || r.ngram.includes("dogfood"));
  // ngrams from t1 are credited (t1 is before the outcome); t2 contributes to occurrences but not outcomes
  expect(dogfood).toBeDefined();
  expect(dogfood!.outcomes).toBeGreaterThanOrEqual(1);
  // ngram only from sB (no outcome in sB) gets 0 outcomes
  const explainRow = rows.find((r) => r.ngram.includes("explain"));
  expect(explainRow?.outcomes ?? 0).toBe(0);
});
