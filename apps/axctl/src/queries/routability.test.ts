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

import { buildSpans } from "./routability.ts";
import type { RepriceUsage } from "./reprice.ts";

const u: RepriceUsage = {
  prompt_tokens: 1000, completion_tokens: 100,
  cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1,
};

function turn(seq: number, role: string, tools: string[], extra: Partial<TurnFacts> = {}): TurnFacts {
  return { seq, role, toolNames: tools, thinkingTokens: 0, intentKind: null, text: null, usage: u, ...extra };
}

describe("buildSpans", () => {
  it("groups consecutive same-class assistant turns into one span", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read", "Grep"]),
      turn(3, "assistant", ["Read"]),
      turn(4, "assistant", ["Read", "Glob"]),
    ];
    const spans = buildSpans(turns, 3);
    // turn 2 is adjacentToUser -> interactive (own span); 3 & 4 -> gather run of 2
    const gather = spans.find((s) => s.cls === "gather");
    expect(gather?.turnCount).toBe(2);
  });

  it("a user turn breaks a run even when class would continue", () => {
    const turns = [
      turn(1, "user", []), turn(2, "assistant", ["Edit"]), turn(3, "assistant", ["Edit"]),
      turn(4, "user", []), turn(5, "assistant", ["Edit"]), turn(6, "assistant", ["Edit"]),
    ];
    const mech = buildSpans(turns, 1).filter((s) => s.cls === "mechanical-impl");
    expect(mech.length).toBe(2);
  });

  it("marks a routable span only when run length >= minRun", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]), // interactive (adjacent)
      turn(3, "assistant", ["Read"]), turn(4, "assistant", ["Read"]), turn(5, "assistant", ["Read"]), // gather run of 3
    ];
    expect(buildSpans(turns, 3).find((s) => s.cls === "gather")?.routable).toBe(true);
    expect(buildSpans(turns, 4).find((s) => s.cls === "gather")?.routable).toBe(false);
  });

  it("sums usage across a span", () => {
    const turns = [
      turn(1, "user", []), turn(2, "assistant", ["Read"]),
      turn(3, "assistant", ["Read"]), turn(4, "assistant", ["Read"]),
    ];
    const gather = buildSpans(turns, 1).find((s) => s.cls === "gather");
    expect(gather?.usage.cost_usd).toBe(2); // turns 3 & 4 (turn 2 is interactive)
  });
});
