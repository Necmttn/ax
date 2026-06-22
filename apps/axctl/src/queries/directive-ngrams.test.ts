import { expect, test } from "bun:test";
import { computeLift } from "./directive-ngrams.ts";

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
