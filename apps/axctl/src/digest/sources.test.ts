import { describe, expect, it } from "bun:test";
import { improveToItem, costToItem, churnToItem, quotaToItem } from "./sources.ts";

describe("source mappers", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("improveToItem maps open-proposal count to an improve item", () => {
    const item = improveToItem(4, now);
    expect(item?.kind).toBe("improve");
    expect(item?.id).toBe("improve:open");
    expect(item?.action).toBe("ax improve recommend");
    expect(item?.text).toContain("4");
  });
  it("improveToItem returns null when zero proposals", () => {
    expect(improveToItem(0, now)).toBeNull();
  });

  it("costToItem maps weekly savings to a cost item", () => {
    const item = costToItem({ savingsPerWeekUsd: 42, inheritPct: 38 }, now);
    expect(item?.kind).toBe("cost");
    expect(item?.action).toBe("ax dispatches --candidates");
    expect(item?.text).toContain("42");
  });
  it("costToItem returns null below a $5/wk floor (not worth surfacing)", () => {
    expect(costToItem({ savingsPerWeekUsd: 3, inheritPct: 10 }, now)).toBeNull();
  });

  it("churnToItem maps repair-loop session to a churn item", () => {
    const item = churnToItem({ sessionId: "s1", repairLoc: 14, failedChecks: 1, topFile: "auth.ts" }, now);
    expect(item?.kind).toBe("churn");
    expect(item?.action).toBe("ax sessions churn --here");
    expect(item?.text).toContain("auth.ts");
  });
  it("churnToItem returns null when no repair LOC", () => {
    expect(churnToItem({ sessionId: "s1", repairLoc: 0, failedChecks: 0, topFile: null }, now)).toBeNull();
  });

  it("quotaToItem surfaces only above 70% window burn", () => {
    expect(quotaToItem({ windowLabel: "7d", pctUsed: 41 }, now)).toBeNull();
    const hot = quotaToItem({ windowLabel: "7d", pctUsed: 82 }, now);
    expect(hot?.kind).toBe("quota");
    expect(hot?.action).toBe("ax quota");
  });
});
