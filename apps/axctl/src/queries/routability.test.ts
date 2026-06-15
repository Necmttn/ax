import { describe, expect, it } from "bun:test";
import { classifyTurn, type TurnFacts } from "./routability.ts";

const base: TurnFacts = {
  seq: 1,
  role: "assistant",
  toolNames: [],
  thinkingTokens: 0,
  intentKind: null,
  text: null,
  usage: null,
};

describe("classifyTurn", () => {
  it("read-only tools, no thinking -> gather", () => {
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep", "Read", "Glob"] }, false)).toBe("gather");
  });
  it("web research + reads -> niche-research", () => {
    expect(classifyTurn({ ...base, toolNames: ["WebFetch", "Read", "WebSearch"] }, false)).toBe("niche-research");
  });
  it("edit/bash dominant, low thinking -> mechanical-impl", () => {
    expect(classifyTurn({ ...base, toolNames: ["Edit", "Bash", "Edit", "Write"] }, false)).toBe("mechanical-impl");
  });
  it("high thinking, no tools -> synthesis", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: [] }, false)).toBe("synthesis");
  });
  it("high thinking + edits -> design-decision", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: ["Edit"] }, false)).toBe("design-decision");
  });
  it("judgment text -> design-decision even with read tools", () => {
    expect(classifyTurn({ ...base, text: "Review the design of this module", toolNames: ["Read"] }, false)).toBe("design-decision");
  });
  it("adjacent to a user turn -> interactive", () => {
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep"] }, true)).toBe("interactive");
  });
  it("correction intent -> interactive", () => {
    expect(classifyTurn({ ...base, intentKind: "correction", toolNames: ["Edit"] }, false)).toBe("interactive");
  });
  it("no signal -> interactive (conservative fallback)", () => {
    expect(classifyTurn(base, false)).toBe("interactive");
  });
});
