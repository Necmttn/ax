import { describe, expect, it } from "bun:test";
import { renderUsage } from "./usage.ts";
import type { UsageRollup } from "../../usage/query.ts";

const roll: UsageRollup = {
  windowDays: 30, total: 5, activeDays: 3,
  topCommands: [{ command: "digest", count: 3, last_used: "2026-06-15T11:00:00.000Z" }],
  topCommandsByOrigin: {
    tty: [{ command: "digest", count: 1, last_used: "2026-06-15T11:00:00.000Z" }],
    agent: [{ command: "quota", count: 4, last_used: "2026-06-15T12:00:00.000Z" }],
  },
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
  it("separates intentional tty usage from background agent usage", () => {
    const out = renderUsage(roll);
    expect(out).toContain("top tty commands:");
    expect(out).toContain("top agent/background commands:");
    expect(out).toMatch(/digest\s+1/);
    expect(out).toMatch(/quota\s+4/);
  });
  it("empty-state line when nothing recorded", () => {
    const empty: UsageRollup = {
      ...roll,
      total: 0,
      activeDays: 0,
      topCommands: [],
      topCommandsByOrigin: { agent: [], tty: [] },
      originSplit: { agent: 0, tty: 0 },
    };
    expect(renderUsage(empty)).toContain("no usage recorded yet");
  });
});
