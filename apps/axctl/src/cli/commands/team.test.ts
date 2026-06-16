import { describe, expect, it } from "bun:test";
import { renderSyncReport, renderTrustReport } from "./team.ts";

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

describe("renderTrustReport", () => {
  it("shows installed count", () => {
    const out = renderTrustReport({ installed: ["hook:enforce-x"], changed: [], added: [], onDefault: true });
    expect(out).toContain("installed 1");
  });
  it("refuses off the default branch when there are hooks to install", () => {
    const out = renderTrustReport({ installed: [], changed: ["hook:x"], added: [], onDefault: false });
    expect(out).toMatch(/default branch|refus|not trusted/i);
  });
  it("empty-state when no executable hooks", () => {
    expect(renderTrustReport({ installed: [], changed: [], added: [], onDefault: true })).toContain("no executable");
  });
});
