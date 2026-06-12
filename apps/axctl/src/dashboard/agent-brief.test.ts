import { describe, expect, test } from "bun:test";
import { renderAgentBrief } from "./agent-brief.ts";

describe("renderAgentBrief", () => {
    test("renders the agreed markdown shape", () => {
        const md = renderAgentBrief({
            title: "Fix `bun test` exit-127 cluster in ax",
            evidence: "14 failures / 6 sessions, exit 127 (sessions: 01jx, 01jy)",
            ask: "Add a PATH-safe test wrapper so `bun test` resolves in worktrees.",
            verify: "`ax sessions churn --here` failure count drops over the next 7d window.",
            source: "ax tool-failure label=Bash",
        });
        expect(md).toBe(
            [
                "## Task: Fix `bun test` exit-127 cluster in ax",
                "",
                "**Evidence:** 14 failures / 6 sessions, exit 127 (sessions: 01jx, 01jy)",
                "",
                "**Ask:** Add a PATH-safe test wrapper so `bun test` resolves in worktrees.",
                "",
                "**Verify:** `ax sessions churn --here` failure count drops over the next 7d window.",
                "",
                "_source: ax tool-failure label=Bash_",
            ].join("\n"),
        );
    });
});
