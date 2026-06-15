import { describe, expect, test } from "bun:test";
import { spendNudge } from "./refresh-quota.ts";

describe("spendNudge", () => {
  test("splurge → /dojo nudge mentioning remaining % and hours", () => {
    const s = spendNudge(
      { mode: "splurge", reason: "x", stale: false },
      { remainingPct: 60, hoursToReset: 12 },
    );
    expect(s).toContain("/dojo");
    expect(s).toContain("60%");
    expect(s).toContain("12h");
  });

  test("conserve → null (no nudge)", () => {
    expect(
      spendNudge(
        { mode: "conserve", reason: "x", stale: false },
        { remainingPct: 60, hoursToReset: 12 },
      ),
    ).toBeNull();
  });

  test("stale conserve → null", () => {
    expect(
      spendNudge(
        { mode: "conserve", reason: "stale cache", stale: true },
        { remainingPct: 60, hoursToReset: 12 },
      ),
    ).toBeNull();
  });

  test("splurge nudge string format contains key elements", () => {
    const s = spendNudge(
      { mode: "splurge", reason: "7d reset soon with surplus", stale: false },
      { remainingPct: 35, hoursToReset: 6 },
    );
    expect(s).not.toBeNull();
    expect(s).toContain("/dojo");
    expect(s).toContain("35%");
    expect(s).toContain("6h");
  });
});
