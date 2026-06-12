import { describe, expect, it } from "bun:test";
import type { DispatchRow } from "./dispatch-analytics.ts";
import {
    normalizeKey,
    clusterRows,
    buildProposals,
    JUDGMENT_RE,
    renderTuneBrief,
    type TuneProposal,
} from "./routing-tune.ts";

const row = (description: string, agent_type = "general-purpose", cost = 1): DispatchRow => ({
    ts: "2026-06-12T00:00:00Z", parent_id: "p", child_id: "c",
    agent_type, description, dispatch_model: "inherit",
    child_model: "claude-fable-5", child_cost_usd: cost,
    prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0,
});

describe("normalizeKey", () => {
    it("two-token lowercase prefix, digits collapsed to N, punctuation stripped", () => {
        expect(normalizeKey("Summarize the changelog")).toBe("summarize the");
        expect(normalizeKey("Port module 3: parser")).toBe("port module");
        expect(normalizeKey("Triage 12 issues")).toBe("triage N");
    });
    it("single-token descriptions key on that token", () => {
        expect(normalizeKey("Refactor")).toBe("refactor");
    });
    it("empty/null-ish input yields null", () => {
        expect(normalizeKey("")).toBeNull();
        expect(normalizeKey("  ")).toBeNull();
    });
});

describe("clusterRows + buildProposals", () => {
    const rows = [
        row("Summarize the changelog", "general-purpose", 2),
        row("Summarize the release notes", "general-purpose", 3),
        row("Summarize the diff", "general-purpose", 1),
        row("Triage 12 issues", "general-purpose", 1),  // count 1 -> dropped
        row("Sweep docs for stale links", "Explore", 1),
        row("Sweep docs for flaky markers", "Explore", 2),
        row("Sweep docs for dead flags", "codebase-locator", 1),
        row("Review architecture of ingest", "general-purpose", 5),
        row("Review architecture of studio", "general-purpose", 5),
        row("Review architecture of hooks", "general-purpose", 5),
    ];

    it("clusters by key and drops below-threshold clusters", () => {
        const clusters = clusterRows(rows);
        const proposals = buildProposals(clusters);
        const ids = proposals.map((p) => p.id);
        expect(ids).toContain("summarize-the");
        expect(ids).toContain("sweep-docs");
        expect(ids).not.toContain("triage-N");
    });

    it("suggests haiku for search-tier-dominated clusters, sonnet otherwise", () => {
        const proposals = buildProposals(clusterRows(rows));
        const sweep = proposals.find((p) => p.id.startsWith("sweep"));
        const summarize = proposals.find((p) => p.id === "summarize-the");
        expect(sweep?.suggest).toBe("haiku");
        expect(summarize?.suggest).toBe("sonnet");
    });

    it("flags judgment clusters; pattern derives from the key with N -> \\d+", () => {
        const proposals = buildProposals(clusterRows(rows));
        const review = proposals.find((p) => p.id === "review-architecture");
        expect(review?.judgment).toBe(true);
        const summarize = proposals.find((p) => p.id === "summarize-the");
        expect(summarize?.pattern).toBe("^summarize\\s+the");
        expect(summarize?.judgment).toBe(false);
        expect(new RegExp(summarize!.pattern, "i").test("Summarize the weekly report")).toBe(true);
    });

    it("orders proposals by total cost desc and carries examples + counts", () => {
        const proposals = buildProposals(clusterRows(rows));
        expect(proposals[0]!.id).toBe("review-architecture"); // $15 cluster
        const summarize = proposals.find((p) => p.id === "summarize-the")!;
        expect(summarize.count).toBe(3);
        expect(summarize.total_cost_usd).toBe(6);
        expect(summarize.examples.length).toBeGreaterThan(0);
    });
});

describe("JUDGMENT_RE", () => {
    it("matches review/critique/design/plan/audit/judge/verify/assess", () => {
        for (const word of ["Review X", "Critique Y", "Design Z", "Plan the migration", "Audit deps", "Judge outputs", "Verify claims", "Assess risk"]) {
            expect(JUDGMENT_RE.test(word)).toBe(true);
        }
        expect(JUDGMENT_RE.test("Summarize the changelog")).toBe(false);
    });
});

describe("renderTuneBrief", () => {
    it("renders proposals with backtest instructions and the apply command", () => {
        const proposals: TuneProposal[] = [{
            id: "summarize-the", pattern: "^summarize\\s+the", flags: "i", suggest: "sonnet",
            reason: "mined 2026-06-12: 3 dispatches, $6.00 addressable",
            count: 3, total_cost_usd: 6, examples: ["Summarize the changelog"], judgment: false,
        }];
        const brief = renderTuneBrief(proposals, { days: 30, date: "2026-06-12" });
        expect(brief).toContain("summarize-the");
        expect(brief).toContain("adversarially");
        expect(brief).toContain("ax routing tune --apply");
    });
});

