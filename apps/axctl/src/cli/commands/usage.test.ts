import { describe, expect, it } from "bun:test";
import { renderUsage } from "./usage.ts";
import type { UsageRollup } from "../../usage/query.ts";

const roll: UsageRollup = {
  windowDays: 30, total: 5, activeDays: 3,
  topCommands: [{ command: "digest", count: 3, last_used: "2026-06-15T11:00:00.000Z" }],
  unusedSurface: ["quota", "thinking"],
  originSplit: { agent: 4, tty: 1 },
  reliability: [],
};

describe("renderUsage", () => {
  it("summarizes active days, top command, and unused count", () => {
    const out = renderUsage(roll);
    expect(out).toContain("3 active days");
    expect(out).toContain("digest");
    expect(out).toContain("2 never used");
  });
  it("empty-state line when nothing recorded", () => {
    const empty: UsageRollup = { ...roll, total: 0, activeDays: 0, topCommands: [], originSplit: { agent: 0, tty: 0 } };
    expect(renderUsage(empty)).toContain("no usage recorded yet");
  });
});
