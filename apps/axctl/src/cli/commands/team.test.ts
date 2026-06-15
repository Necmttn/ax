import { describe, expect, it } from "bun:test";
import { renderSyncReport } from "./team.ts";

describe("renderSyncReport", () => {
  it("summarizes activated, unchanged, and gated", () => {
    const out = renderSyncReport({ activated: ["skill:tdd", "agent:rev"], unchanged: ["skill:x"], gated: ["guard"] });
    expect(out).toContain("activated 2");
    expect(out).toContain("1 unchanged");
    expect(out).toContain("guard");
    expect(out).toMatch(/gated|executable|trust/i);
  });
  it("empty-state when no rig", () => {
    expect(renderSyncReport({ activated: [], unchanged: [], gated: [] })).toContain("no team rig");
  });
});
